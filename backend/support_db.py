"""
Support messaging — user ↔ admin threads with file attachments.
"""
from __future__ import annotations

import os
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Optional

from auth_db import DATA_DIR, connect, get_user_by_id, _utcnow

ATTACHMENTS_DIR = DATA_DIR / "support_attachments"
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8 MB
MAX_ATTACHMENTS_PER_MESSAGE = 5
ALLOWED_MIME = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "application/pdf",
}


def init_support_db() -> None:
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS support_threads (
              id TEXT PRIMARY KEY,
              user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              admin_last_read_at TEXT,
              user_last_read_at TEXT
            );

            CREATE TABLE IF NOT EXISTS support_messages (
              id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
              sender_id TEXT NOT NULL REFERENCES users(id),
              body TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS support_attachments (
              id TEXT PRIMARY KEY,
              message_id TEXT NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
              filename TEXT NOT NULL,
              mime_type TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              storage_path TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_support_messages_thread
              ON support_messages(thread_id, created_at);
            """
        )


def _safe_filename(name: str) -> str:
    base = Path(name).name
    base = re.sub(r"[^\w.\- ()]", "_", base)[:120]
    return base or "file"


def _thread_row(row: sqlite3.Row, username: Optional[str] = None) -> dict:
    out = {
        "id": row["id"],
        "userId": row["user_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "adminLastReadAt": row["admin_last_read_at"],
        "userLastReadAt": row["user_last_read_at"],
    }
    if username:
        out["username"] = username
    return out


def get_or_create_thread(user_id: str) -> dict:
    now = _utcnow()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM support_threads WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row:
            u = conn.execute(
                "SELECT username FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return _thread_row(row, u["username"] if u else None)
        tid = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO support_threads
              (id, user_id, created_at, updated_at, admin_last_read_at, user_last_read_at)
            VALUES (?, ?, ?, ?, NULL, ?)
            """,
            (tid, user_id, now, now, now),
        )
        row = conn.execute("SELECT * FROM support_threads WHERE id = ?", (tid,)).fetchone()
        u = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        return _thread_row(row, u["username"] if u else None)


def get_thread(thread_id: str) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM support_threads WHERE id = ?", (thread_id,)
        ).fetchone()


def list_threads_for_admin() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.*, u.username,
              (SELECT body FROM support_messages m
               WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM support_messages m
               WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
              (SELECT COUNT(*) FROM support_messages m
               JOIN users s ON s.id = m.sender_id
               WHERE m.thread_id = t.id AND s.role = 'user'
                 AND (t.admin_last_read_at IS NULL OR m.created_at > t.admin_last_read_at)
              ) AS admin_unread
            FROM support_threads t
            JOIN users u ON u.id = t.user_id
            ORDER BY COALESCE(last_message_at, t.updated_at) DESC
            """
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            item = _thread_row(r, r["username"])
            item["lastMessagePreview"] = (r["last_body"] or "")[:200]
            item["lastMessageAt"] = r["last_message_at"] or r["updated_at"]
            item["unreadCount"] = int(r["admin_unread"] or 0)
            out.append(item)
        return out


def list_messages(thread_id: str, limit: int = 100) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT m.*, u.username, u.role AS sender_role
            FROM support_messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.thread_id = ?
            ORDER BY m.created_at ASC
            LIMIT ?
            """,
            (thread_id, limit),
        ).fetchall()
        msg_ids = [r["id"] for r in rows]
        attachments_by_msg: dict[str, list[dict]] = {mid: [] for mid in msg_ids}
        if msg_ids:
            placeholders = ",".join("?" * len(msg_ids))
            att_rows = conn.execute(
                f"""
                SELECT * FROM support_attachments
                WHERE message_id IN ({placeholders})
                ORDER BY created_at ASC
                """,
                msg_ids,
            ).fetchall()
            for a in att_rows:
                attachments_by_msg[a["message_id"]].append({
                    "id": a["id"],
                    "filename": a["filename"],
                    "mimeType": a["mime_type"],
                    "sizeBytes": a["size_bytes"],
                })
        return [
            {
                "id": r["id"],
                "threadId": r["thread_id"],
                "senderId": r["sender_id"],
                "senderUsername": r["username"],
                "senderRole": r["sender_role"],
                "body": r["body"],
                "createdAt": r["created_at"],
                "attachments": attachments_by_msg.get(r["id"], []),
            }
            for r in rows
        ]


def create_message(
    thread_id: str,
    sender_id: str,
    body: str,
    files: list[tuple[str, str, bytes]],
) -> dict:
    """files: list of (filename, mime_type, content)"""
    body = (body or "").strip()
    if not body and not files:
        raise ValueError("Message must have text or attachments")
    if len(files) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise ValueError(f"Max {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message")

    mid = str(uuid.uuid4())
    now = _utcnow()

    saved_files: list[tuple[str, str, str, int, str]] = []
    for filename, mime, content in files:
        if mime not in ALLOWED_MIME:
            raise ValueError(f"File type not allowed: {mime}")
        if len(content) > MAX_ATTACHMENT_BYTES:
            raise ValueError(f"File too large (max {MAX_ATTACHMENT_BYTES // (1024*1024)} MB)")
        aid = str(uuid.uuid4())
        safe = _safe_filename(filename)
        rel = f"support_attachments/{aid}_{safe}"
        path = DATA_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        saved_files.append((aid, safe, mime, len(content), rel))

    with connect() as conn:
        thread = conn.execute(
            "SELECT id FROM support_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            raise ValueError("Thread not found")
        conn.execute(
            """
            INSERT INTO support_messages (id, thread_id, sender_id, body, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (mid, thread_id, sender_id, body, now),
        )
        attachments: list[dict] = []
        for aid, safe, mime, size, rel in saved_files:
            conn.execute(
                """
                INSERT INTO support_attachments
                  (id, message_id, filename, mime_type, size_bytes, storage_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (aid, mid, safe, mime, size, rel, now),
            )
            attachments.append({
                "id": aid,
                "filename": safe,
                "mimeType": mime,
                "sizeBytes": size,
            })
        conn.execute(
            "UPDATE support_threads SET updated_at = ? WHERE id = ?",
            (now, thread_id),
        )
        sender = conn.execute(
            "SELECT username, role FROM users WHERE id = ?", (sender_id,)
        ).fetchone()
        return {
            "id": mid,
            "threadId": thread_id,
            "senderId": sender_id,
            "senderUsername": sender["username"] if sender else "",
            "senderRole": sender["role"] if sender else "user",
            "body": body,
            "createdAt": now,
            "attachments": attachments,
        }


def get_attachment(attachment_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT a.*, m.thread_id, t.user_id AS thread_user_id
            FROM support_attachments a
            JOIN support_messages m ON m.id = a.message_id
            JOIN support_threads t ON t.id = m.thread_id
            WHERE a.id = ?
            """,
            (attachment_id,),
        ).fetchone()
        if not row:
            return None
        path = DATA_DIR / row["storage_path"]
        if not path.is_file():
            return None
        return {
            "id": row["id"],
            "filename": row["filename"],
            "mimeType": row["mime_type"],
            "sizeBytes": row["size_bytes"],
            "path": path,
            "threadId": row["thread_id"],
            "threadUserId": row["thread_user_id"],
        }


def mark_thread_read(thread_id: str, *, as_admin: bool) -> None:
    now = _utcnow()
    col = "admin_last_read_at" if as_admin else "user_last_read_at"
    with connect() as conn:
        conn.execute(
            f"UPDATE support_threads SET {col} = ? WHERE id = ?",
            (now, thread_id),
        )


def count_unread_for_user(user_id: str, role: str) -> int:
    with connect() as conn:
        if role == "admin":
            row = conn.execute(
                """
                SELECT COUNT(*) AS c FROM support_messages m
                JOIN support_threads t ON t.id = m.thread_id
                JOIN users s ON s.id = m.sender_id
                WHERE s.role = 'user'
                  AND (t.admin_last_read_at IS NULL OR m.created_at > t.admin_last_read_at)
                """
            ).fetchone()
            return int(row["c"] or 0)
        row = conn.execute(
            """
            SELECT COUNT(*) AS c FROM support_messages m
            JOIN support_threads t ON t.id = m.thread_id
            JOIN users s ON s.id = m.sender_id
            WHERE t.user_id = ? AND s.role = 'admin'
              AND (t.user_last_read_at IS NULL OR m.created_at > t.user_last_read_at)
            """,
            (user_id,),
        ).fetchone()
        return int(row["c"] or 0)
