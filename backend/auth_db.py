"""
SQLite auth + projects store for BubbleBIM Clean (multi-user).
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

import bcrypt

DATA_DIR = Path(os.getenv("BUBBLEBIM_DATA_DIR", str(Path(__file__).parent / "data")))
DB_PATH = DATA_DIR / "bubblebim.db"

_EMPTY_GRAPH: dict = {
    "nodes": [],
    "edges": [],
    "buildingAxes": {"xValues": [], "yValues": []},
    "projectName": "My Building",
    "activeStoreyId": None,
    "worldLocation": None,
    "globeInstances": [],
    "annotations": [],
    "composerShapes": [],
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'user',
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              data TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
            """
        )
    _ensure_admin()
    try:
        from support_db import init_support_db
        init_support_db()
    except Exception as exc:
        print(f"⚠ Support DB init skipped: {exc}")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def _ensure_admin() -> None:
    username = os.getenv("ADMIN_USERNAME", "admin").strip() or "admin"
    password = os.getenv("ADMIN_PASSWORD", "admin123").strip() or "admin123"
    with connect() as conn:
        row = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if row:
            return
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        now = _utcnow()
        if existing:
            conn.execute(
                "UPDATE users SET role = 'admin', password_hash = ?, active = 1, updated_at = ? WHERE id = ?",
                (hash_password(password), now, existing["id"]),
            )
            return
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)",
            (str(uuid.uuid4()), username, hash_password(password), now, now),
        )
        print(f"✓ Admin user created: {username}")


def user_public(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE username = ?", (username.strip().lower(),)
        ).fetchone()


def get_user_by_id(user_id: str) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def create_user(username: str, password: str, role: str = "user") -> dict:
    uid = str(uuid.uuid4())
    now = _utcnow()
    uname = username.strip().lower()
    if not uname or len(uname) < 3:
        raise ValueError("Username must be at least 3 characters")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters")
    if role not in ("user", "admin"):
        raise ValueError("Invalid role")
    with connect() as conn:
        try:
            conn.execute(
                "INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
                (uid, uname, hash_password(password), role, now, now),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("Username already taken") from exc
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return user_public(row)


def list_users() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY created_at ASC"
        ).fetchall()
        return [user_public(r) for r in rows]


def update_user(
    user_id: str,
    *,
    active: Optional[bool] = None,
    role: Optional[str] = None,
    password: Optional[str] = None,
) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise ValueError("User not found")
        fields: list[str] = []
        values: list[Any] = []
        if active is not None:
            fields.append("active = ?")
            values.append(1 if active else 0)
        if role is not None:
            if role not in ("user", "admin"):
                raise ValueError("Invalid role")
            fields.append("role = ?")
            values.append(role)
        if password is not None:
            if len(password) < 6:
                raise ValueError("Password must be at least 6 characters")
            fields.append("password_hash = ?")
            values.append(hash_password(password))
        if not fields:
            return user_public(row)
        fields.append("updated_at = ?")
        values.append(_utcnow())
        values.append(user_id)
        conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user_public(row)


def _project_meta(row: sqlite3.Row, include_owner: bool = False) -> dict:
    out = {
        "id": row["id"],
        "name": row["name"],
        "userId": row["user_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if include_owner and "username" in row.keys():
        out["ownerUsername"] = row["username"]
    return out


def list_projects_for_user(user_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
        return [_project_meta(r) for r in rows]


def list_all_projects() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT p.*, u.username
            FROM projects p
            JOIN users u ON u.id = p.user_id
            ORDER BY p.updated_at DESC
            """
        ).fetchall()
        return [_project_meta(r, include_owner=True) for r in rows]


def create_project(user_id: str, name: str, data: Optional[dict] = None) -> dict:
    pid = str(uuid.uuid4())
    now = _utcnow()
    graph = dict(_EMPTY_GRAPH)
    if data:
        graph.update(data)
    graph["projectName"] = name.strip() or "Untitled"
    with connect() as conn:
        conn.execute(
            "INSERT INTO projects (id, user_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (pid, user_id, graph["projectName"], json.dumps(graph, ensure_ascii=False), now, now),
        )
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        return _project_meta(row)


def get_project(project_id: str) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()


def get_project_data(project_id: str) -> Optional[dict]:
    row = get_project(project_id)
    if not row:
        return None
    try:
        data = json.loads(row["data"])
    except Exception:
        data = dict(_EMPTY_GRAPH)
    data["id"] = row["id"]
    data["projectName"] = row["name"]
    return data


def save_project_data(project_id: str, data: dict, name: Optional[str] = None) -> dict:
    now = _utcnow()
    with connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise ValueError("Project not found")
        new_name = (name or data.get("projectName") or row["name"] or "Untitled").strip()
        payload = dict(data)
        payload["projectName"] = new_name
        conn.execute(
            "UPDATE projects SET name = ?, data = ?, updated_at = ? WHERE id = ?",
            (new_name, json.dumps(payload, ensure_ascii=False), now, project_id),
        )
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return _project_meta(row)


def delete_project(project_id: str) -> None:
    with connect() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cur.rowcount == 0:
            raise ValueError("Project not found")
    shutil.rmtree(get_project_history_dir(project_id), ignore_errors=True)


def get_project_history_dir(project_id: str) -> Path:
    """Root directory for a project's version-history commit log + content-
    addressable blobs (see version_history.py's VersionHistory) — one per
    project, nested under the same BUBBLEBIM_DATA_DIR the SQLite db and auth
    data already live in, so it survives container rebuilds via the same
    mounted volume without any extra docker-compose wiring."""
    d = DATA_DIR / "project_history" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def user_owns_project(user_id: str, project_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM projects WHERE id = ? AND user_id = ?",
            (project_id, user_id),
        ).fetchone()
        return row is not None
