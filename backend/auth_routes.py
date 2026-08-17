"""
Auth + projects API routes for BubbleBIM Clean.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from auth_db import (
    create_project,
    create_user,
    delete_project,
    get_project,
    get_project_data,
    get_project_history_dir,
    get_user_by_id,
    get_user_by_username,
    init_db,
    list_all_projects,
    list_projects_for_user,
    list_users,
    save_project_data,
    update_user,
    user_public,
    verify_password,
)
from version_history import VersionHistory

router = APIRouter()
security = HTTPBearer(auto_error=False)

JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production-bubblebim")
JWT_ALG = "HS256"
JWT_DAYS = int(os.getenv("JWT_EXPIRE_DAYS", "14"))


class RegisterBody(BaseModel):
    username: str
    password: str


class LoginBody(BaseModel):
    username: str
    password: str


class CreateProjectBody(BaseModel):
    name: str = "Untitled"
    data: Optional[dict[str, Any]] = None


class SaveProjectBody(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    buildingAxes: dict[str, Any] = Field(default_factory=lambda: {"xValues": [], "yValues": []})
    activeStoreyId: Optional[str] = None
    projectName: str = "My Building"
    worldLocation: Optional[dict[str, Any]] = None
    globeInstances: list[dict[str, Any]] = Field(default_factory=list)
    annotations: list[dict[str, Any]] = Field(default_factory=list)
    composerShapes: list[dict[str, Any]] = Field(default_factory=list)
    # Open drawing tabs (plans/sections/elevations) + active tab — pydantic
    # drops undeclared fields, so without these the drawing workspace was
    # silently lost on every cloud save (same fix as main.py's GraphData).
    viewTabs: list[dict[str, Any]] = Field(default_factory=list)
    activeTabId: Optional[str] = None


class AdminCreateUserBody(BaseModel):
    username: str
    password: str
    role: str = "user"


class AdminUpdateUserBody(BaseModel):
    active: Optional[bool] = None
    role: Optional[str] = None
    password: Optional[str] = None


def _make_token(user_id: str, username: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = _decode_token(creds.credentials)
    user = get_user_by_id(payload["sub"])
    if not user or not user["active"]:
        raise HTTPException(status_code=401, detail="User inactive or missing")
    return user_public(user)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


def _check_project_access(project_id: str, user: dict):
    """Same ownership rule as the existing GET/PUT/DELETE /projects/{id} routes."""
    row = get_project(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if user["role"] != "admin" and row["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    return row


def _project_history(project_id: str) -> VersionHistory:
    return VersionHistory(get_project_history_dir(project_id))


@router.post("/auth/register")
async def register(body: RegisterBody):
    try:
        user = create_user(body.username, body.password, role="user")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = _make_token(user["id"], user["username"], user["role"])
    return {"token": token, "user": user}


@router.post("/auth/login")
async def login(body: LoginBody):
    user = get_user_by_username(body.username)
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not user["active"]:
        raise HTTPException(status_code=403, detail="Account disabled")
    pub = user_public(user)
    token = _make_token(pub["id"], pub["username"], pub["role"])
    return {"token": token, "user": pub}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


@router.get("/projects")
async def projects_list(user: dict = Depends(get_current_user)):
    return {"projects": list_projects_for_user(user["id"])}


@router.post("/projects")
async def projects_create(body: CreateProjectBody, user: dict = Depends(get_current_user)):
    project = create_project(user["id"], body.name, body.data)
    return {"project": project}


@router.get("/projects/{project_id}")
async def projects_get(project_id: str, user: dict = Depends(get_current_user)):
    row = get_project(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if user["role"] != "admin" and row["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    data = get_project_data(project_id)
    return data


@router.put("/projects/{project_id}")
async def projects_save(
    project_id: str,
    body: SaveProjectBody,
    user: dict = Depends(get_current_user),
):
    row = get_project(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if user["role"] != "admin" and row["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    payload = body.model_dump()
    meta = save_project_data(project_id, payload, name=body.projectName)
    return {"success": True, "project": meta}


@router.delete("/projects/{project_id}")
async def projects_delete(project_id: str, user: dict = Depends(get_current_user)):
    row = get_project(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if user["role"] != "admin" and row["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    delete_project(project_id)  # also removes the project's history/ dir — see auth_db.py
    return {"success": True}


# ─── Per-project version history (git-like commit log) ────────────────────
# Mirrors main.py's global /api/graph/history/* routes, but scoped to one
# project's own VersionHistory root (backend/data/project_history/<id>/) —
# see version_history.py for the content-addressable commit design and
# get_project_history_dir() in auth_db.py for how the root is chosen.

@router.post("/projects/{project_id}/history/commit")
async def project_history_commit(
    project_id: str, message: str = "", kind: str = "manual",
    user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    if kind not in ("manual", "auto", "checkpoint", "pre-ifc-import"):
        raise HTTPException(status_code=400, detail=f"Invalid kind: {kind}")
    data = get_project_data(project_id)
    entry = _project_history(project_id).commit(data, message, kind)  # type: ignore[arg-type]
    return {"success": True, "commit": entry}


@router.get("/projects/{project_id}/history")
async def project_history_list(
    project_id: str, limit: int = 50, user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    return {"commits": _project_history(project_id).list_commits(limit=limit)}


@router.get("/projects/{project_id}/history/diff/summary")
async def project_history_diff(
    project_id: str, from_id: int, to_id: int, user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    diff = _project_history(project_id).diff_summary(from_id, to_id)
    if diff is None:
        raise HTTPException(status_code=404, detail="One or both commits not found")
    return diff


@router.get("/projects/{project_id}/history/{commit_id}")
async def project_history_get(
    project_id: str, commit_id: int, include_content: bool = False,
    user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    vh = _project_history(project_id)
    entry = vh.get_commit(commit_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Commit not found")
    result = {"commit": entry}
    if include_content:
        result["content"] = vh.get_content(commit_id)
    return result


@router.post("/projects/{project_id}/history/restore/{commit_id}")
async def project_history_restore(
    project_id: str, commit_id: int, user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    result = _project_history(project_id).restore(commit_id)
    if not result:
        raise HTTPException(status_code=404, detail="Commit not found")
    save_project_data(project_id, result["content"])
    return {
        "success": True,
        "commit": result["commit"],
        "nodes_restored": len(result["content"].get("nodes", [])),
        "edges_restored": len(result["content"].get("edges", [])),
    }


@router.post("/projects/{project_id}/history/gc")
async def project_history_gc(
    project_id: str, keep_auto: int = 50, user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    vh = _project_history(project_id)
    pruned = vh.prune_auto_commits(keep=keep_auto)
    freed = vh.gc()
    return {"success": True, "pruned_commits": pruned, **freed}


@router.post("/projects/{project_id}/history/{commit_id}/comment")
async def project_history_comment(
    project_id: str, commit_id: int, text: str, user: dict = Depends(get_current_user),
):
    _check_project_access(project_id, user)
    entry = _project_history(project_id).add_comment(commit_id, text)
    if not entry:
        raise HTTPException(status_code=404, detail="Commit not found")
    return {"success": True, "commit": entry}


@router.get("/admin/users")
async def admin_users(_: dict = Depends(require_admin)):
    return {"users": list_users()}


@router.post("/admin/users")
async def admin_create_user(body: AdminCreateUserBody, _: dict = Depends(require_admin)):
    try:
        user = create_user(body.username, body.password, role=body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"user": user}


@router.patch("/admin/users/{user_id}")
async def admin_update_user(
    user_id: str,
    body: AdminUpdateUserBody,
    admin: dict = Depends(require_admin),
):
    if user_id == admin["id"] and body.active is False:
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")
    try:
        user = update_user(
            user_id,
            active=body.active,
            role=body.role,
            password=body.password,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"user": user}


@router.get("/admin/projects")
async def admin_projects(_: dict = Depends(require_admin)):
    return {"projects": list_all_projects()}
