"""
Support messaging API — user ↔ admin with image/PDF attachments.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from auth_db import get_user_by_id
from auth_routes import get_current_user, require_admin
from support_db import (
    count_unread_for_user,
    create_message,
    get_attachment,
    get_or_create_thread,
    get_thread,
    init_support_db,
    list_messages,
    list_threads_for_admin,
    mark_thread_read,
)

router = APIRouter()


def _can_access_thread(user: dict, thread_row) -> bool:
    if user["role"] == "admin":
        return True
    return thread_row["user_id"] == user["id"]


@router.get("/support/unread-count")
async def support_unread(user: dict = Depends(get_current_user)):
    return {"count": count_unread_for_user(user["id"], user["role"])}


@router.get("/support/thread")
async def support_my_thread(user: dict = Depends(get_current_user)):
    """Get or create the current user's support thread."""
    if user["role"] == "admin":
        raise HTTPException(
            status_code=400,
            detail="Admins should use GET /support/threads",
        )
    thread = get_or_create_thread(user["id"])
    messages = list_messages(thread["id"])
    mark_thread_read(thread["id"], as_admin=False)
    return {"thread": thread, "messages": messages}


@router.get("/support/threads")
async def support_list_threads(_: dict = Depends(require_admin)):
    return {"threads": list_threads_for_admin()}


@router.get("/support/threads/{thread_id}/messages")
async def support_thread_messages(
    thread_id: str,
    user: dict = Depends(get_current_user),
):
    row = get_thread(thread_id)
    if not row:
        raise HTTPException(status_code=404, detail="Thread not found")
    if not _can_access_thread(user, row):
        raise HTTPException(status_code=403, detail="Forbidden")
    messages = list_messages(thread_id)
    mark_thread_read(thread_id, as_admin=(user["role"] == "admin"))
    owner = get_user_by_id(row["user_id"])
    thread = {
        "id": row["id"],
        "userId": row["user_id"],
        "username": owner["username"] if owner else "",
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    return {"thread": thread, "messages": messages}


@router.post("/support/threads/{thread_id}/messages")
async def support_post_message(
    thread_id: str,
    body: str = Form(""),
    files: list[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    row = get_thread(thread_id)
    if not row:
        raise HTTPException(status_code=404, detail="Thread not found")
    if not _can_access_thread(user, row):
        raise HTTPException(status_code=403, detail="Forbidden")

    file_payloads: list[tuple[str, str, bytes]] = []
    for f in files:
        if not f.filename:
            continue
        content = await f.read()
        mime = f.content_type or "application/octet-stream"
        file_payloads.append((f.filename, mime, content))

    try:
        msg = create_message(thread_id, user["id"], body, file_payloads)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"message": msg}


@router.get("/support/attachments/{attachment_id}")
async def support_download_attachment(
    attachment_id: str,
    user: dict = Depends(get_current_user),
):
    att = get_attachment(attachment_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    row = get_thread(att["threadId"])
    if not row or not _can_access_thread(user, row):
        raise HTTPException(status_code=403, detail="Forbidden")
    return FileResponse(
        path=att["path"],
        media_type=att["mimeType"],
        filename=att["filename"],
    )
