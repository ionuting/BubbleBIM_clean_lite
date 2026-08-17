"""
BubbleGraph API Backend - Python + FastAPI + JSON storage
Stores the entire graph as a single JSON file -- simple, robust, zero graph-DB dependencies.
"""

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI, HTTPException, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from contextlib import asynccontextmanager
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
import os
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime
import json
import re
import subprocess
import yaml
import tempfile

load_dotenv()

# ─── Shapely wall geometry (optional — graceful fallback if not installed) ──
try:
    from wall_geometry import compute_wall_footprints as _compute_wall_footprints
    _SHAPELY_AVAILABLE = True
except ImportError:
    _compute_wall_footprints = None  # type: ignore
    _SHAPELY_AVAILABLE = False

# ─── IFC parser (pure Python, no external deps) ───────────────────────────
try:
    from ifc_parser import parse_ifc_storey as _parse_ifc_storey, parse_ifc_plan as _parse_ifc_plan
    _IFC_PARSER_AVAILABLE = True
except ImportError:
    _parse_ifc_storey = None  # type: ignore
    _parse_ifc_plan   = None  # type: ignore
    _IFC_PARSER_AVAILABLE = False

# ─── Ollama / phi3 (optional) ─────────────────────────────────────────────
try:
    import ollama as _ollama_lib
    _OLLAMA_AVAILABLE = True
except ImportError:
    _ollama_lib = None  # type: ignore
    _OLLAMA_AVAILABLE = False

OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL", "phi3")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# --- Paths ----------------------------------------------------------------

GRAPH_PATH     = Path(__file__).parent / "bubble_graph.json"
BACKUP_PATH    = Path(__file__).parent / "backups"
LIBRARY_PATH   = Path(__file__).parent / "library"
NATURE_PATH    = Path(__file__).parent.parent / "Ultimate Stylized Nature" / "glTF"
MATERIALS_PATH = Path(__file__).parent / "materials.yaml"
BACKUP_PATH.mkdir(exist_ok=True)

# ─── Version history (git-like commit log) ─────────────────────────────────
# Content-addressable, replaces the old backups/ folder's one-full-copy-per-
# timestamp scheme going forward — see version_history.py's module docstring.
# The old /api/graph/backup(s)/restore endpoints below are left in place
# (nothing currently calls them from the app, but they're harmless and
# untouched for anyone/anything else still relying on them).
from version_history import VersionHistory
history = VersionHistory(Path(__file__).parent)

# ─── Models ───────────────────────────────────────────────────────────────

class BubbleGraphNode(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    
    id: str
    type: str
    name: str = ""
    x: float
    y: float
    parentId: Optional[str] = None
    properties: dict = Field(default_factory=dict)


class BubbleGraphEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    
    id: str
    from_id: str = Field(alias="from")
    to_id: str = Field(alias="to")


class BuildingAxes(BaseModel):
    xValues: list[float] = Field(default_factory=list)
    yValues: list[float] = Field(default_factory=list)


class WorldLocation(BaseModel):
    lat: float = 44.4268
    lng: float = 26.1025
    alt: float = 0.0
    offsetE: float = 0.0
    offsetN: float = 0.0
    offsetZ: float = 0.0
    rotation: float = 0.0


class GraphData(BaseModel):
    nodes: list[BubbleGraphNode] = Field(default_factory=list)
    edges: list[BubbleGraphEdge] = Field(default_factory=list)
    buildingAxes: BuildingAxes = Field(default_factory=BuildingAxes)
    activeStoreyId: Optional[str] = None
    projectName: str = "My Building"
    worldLocation: Optional[WorldLocation] = None
    globeInstances: list[dict] = Field(default_factory=list)
    # Pydantic silently DROPS fields not declared here — the client was already
    # sending annotations (plan dimension lines / labels) and composerShapes,
    # but they never survived a save round-trip until these were added.
    annotations: list[dict] = Field(default_factory=list)
    composerShapes: list[dict] = Field(default_factory=list)
    # Open drawing tabs (floor plans / sections / elevations / etc.) + which one
    # is active — the "workspace layout" part of the app state, so reopening the
    # app restores the drawings you were working on, matching what the .bbim
    # file format (projectFile.ts) already preserved.
    viewTabs: list[dict] = Field(default_factory=list)
    activeTabId: Optional[str] = None


# Render provides $PORT; fall back to BACKEND_PORT (local dev) then 8000.
BACKEND_PORT = int(os.getenv("PORT") or os.getenv("BACKEND_PORT", "8000"))

# --- JSON store -----------------------------------------------------------

_EMPTY: dict = {
    "nodes": [], "edges": [],
    "buildingAxes": {"xValues": [], "yValues": []},
    "projectName": "My Building",
    "activeStoreyId": None,
    "worldLocation": None,
    "globeInstances": [],
}


def _load() -> dict:
    if not GRAPH_PATH.exists():
        return dict(_EMPTY)
    try:
        with open(GRAPH_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Could not read {GRAPH_PATH}: {e}")
        return dict(_EMPTY)


def _save(data: dict) -> None:
    """Atomic write via temp-file rename -- safe against crashes mid-write."""
    tmp = GRAPH_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(GRAPH_PATH)
    print(f"Saved -> {GRAPH_PATH.name}  "
          f"({len(data.get('nodes', []))} nodes, {len(data.get('edges', []))} edges)")


# --- One-time migration from LadybugDB ------------------------------------

def _migrate_from_ladybugdb() -> bool:
    """
    If bubble_graph.json does not exist but bubble_graph.db does,
    read LadybugDB once and write the JSON file.
    """
    old_db = Path(__file__).parent / "bubble_graph.db"
    if not old_db.exists() or GRAPH_PATH.exists():
        return False
    try:
        from real_ladybug import Database, Connection  # optional import

        db   = Database(str(old_db))
        conn = Connection(db)

        nodes_out: list[dict] = []
        for row in conn.execute(
            "MATCH (n:BubbleNode) RETURN n.id, n.type, n.name, n.x, n.y, n.parentId, n.properties"
        ):
            if row[1] == "__meta__":
                continue
            try:
                props = json.loads(row[6]) if row[6] else {}
            except Exception:
                props = {}
            nodes_out.append({
                "id": row[0], "type": row[1], "name": row[2] or "",
                "x": float(row[3]), "y": float(row[4]),
                "parentId": row[5] if row[5] not in ("NULL", None) else None,
                "properties": props,
            })

        edges_out: list[dict] = []
        try:
            for row in conn.execute(
                "MATCH (a:BubbleNode)-[r:CONNECTED]->(b:BubbleNode) RETURN r.id, a.id, b.id"
            ):
                edges_out.append({"id": row[0], "from": row[1], "to": row[2]})
        except Exception:
            pass

        axes = {"xValues": [], "yValues": []}
        try:
            for row in conn.execute(
                "MATCH (n:BubbleNode {id: '__building_axes__'}) RETURN n.properties"
            ):
                axes = json.loads(row[0]) if row[0] else axes
                break
        except Exception:
            pass

        project_name = "My Building"
        try:
            for row in conn.execute(
                "MATCH (n:BubbleNode {id: '__project__'}) RETURN n.properties"
            ):
                project_name = (json.loads(row[0]) if row[0] else {}).get("name", "My Building")
                break
        except Exception:
            pass

        conn.close()
        db.close()

        _save({
            "nodes": nodes_out,
            "edges": edges_out,
            "buildingAxes": axes,
            "projectName": project_name,
            "activeStoreyId": None,
        })
        print(f"Migrated {len(nodes_out)} nodes + {len(edges_out)} edges  LadybugDB -> JSON")
        return True
    except Exception as e:
        print(f"LadybugDB migration skipped: {e}")
        return False


def free_port(port: int) -> None:
    try:
        result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                pid = int(parts[-1])
                if pid and pid != os.getpid():
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                   capture_output=True, timeout=5)
                    print(f"[startup] Freed port {port} (killed PID {pid})")
    except Exception:
        pass


# ─── Lifespan ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("BubbleGraph API starting...")
    print(f"Graph file : {GRAPH_PATH}")
    print(f"Backups    : {BACKUP_PATH}")
    _migrate_from_ladybugdb()
    if not GRAPH_PATH.exists():
        _save(dict(_EMPTY))
        print("Created empty graph file")
    try:
        from auth_db import init_db
        init_db()
        print("Auth DB ready")
    except Exception as exc:
        print(f"⚠ Auth DB init failed: {exc}")
    yield
    print("BubbleGraph API shutting down...")


# ─── FastAPI App ──────────────────────────────────────────────────────────

app = FastAPI(
    title="BubbleGraph API",
    description="BIM graph backend -- JSON file storage",
    version="2.0.0",
    lifespan=lifespan,
)

# Enable CORS for frontend
_extra_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3103",
        "http://localhost:3102",
        "http://localhost:3101",
        "http://localhost:3100",
        "http://localhost:5173",
        "https://app.bubblegraph.local",
        *_extra_origins,
    ],
    allow_origin_regex=r"https://.*\.(onrender\.com|ciuntucbimstudio\.ro)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Multi-user auth + projects (Clean cloud)
from auth_routes import router as auth_router
from support_routes import router as support_router
app.include_router(auth_router, prefix="/api")
app.include_router(support_router, prefix="/api")


# ─── API Routes ───────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "api": "BubbleGraph Backend (JSON store)",
        "version": "2.0.0",
        "endpoints": [
            "GET  /api/health",
            "GET  /api/graph/load",
            "POST /api/graph/save",
            "GET  /api/graph/search?q=",
            "GET  /api/graph/search-by-type?type=",
            "GET  /api/graph/stats",
            "POST /api/graph/backup",
            "GET  /api/graph/backups",
            "POST /api/graph/restore",
            "POST /api/graph/history/commit?message=&kind=",
            "GET  /api/graph/history?limit=",
            "GET  /api/graph/history/{commit_id}?include_content=",
            "POST /api/graph/history/restore/{commit_id}",
            "GET  /api/graph/history/diff/summary?from_id=&to_id=",
            "POST /api/graph/history/gc?keep_auto=",
            "POST /api/graph/history/{commit_id}/comment?text=",
            "GET  /api/library/{family}",
            "GET  /library/{file_path}",
            "GET  /api/material-config",
            "PUT  /api/material-config",
        ],
    }


@app.get("/api/library/{family}")
async def get_library_entries(family: str):
    """
    Return the catalogue entries for a given BIM element family.
    Source: backend/library/{family}/library.yaml
    Supported families: window, door, wall, beam, column, slab, foundation, objects
    """
    allowed = {"window", "door", "wall", "beam", "column", "slab", "foundation", "objects"}
    if family not in allowed:
        raise HTTPException(status_code=400, detail=f"Unknown family '{family}'. Allowed: {sorted(allowed)}")

    yaml_path = LIBRARY_PATH / f"{family}s" / "library.yaml"
    # Singular / exact folder names
    if not yaml_path.exists():
        yaml_path = LIBRARY_PATH / family / "library.yaml"

    if not yaml_path.exists():
        return {"family": family, "entries": [], "categories": [], "source": "not_found"}

    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        entries    = data.get("entries", [])
        categories = data.get("categories", [])
        return {
            "family": family,
            "entries": entries,
            "categories": categories,
            "source": str(yaml_path.relative_to(LIBRARY_PATH)),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read library YAML: {e}")


@app.post("/api/library/objects/upload")
async def upload_library_object(
    category: str,
    object_id: str,
    file: UploadFile = File(...),
):
    """
    Upload a GLB or SVG file for a library object.
    Saves to backend/library/objects/{category}/{object_id}/{filename}.
    """
    # Sanitize inputs
    import re as _re
    safe_re = _re.compile(r"^[a-z0-9_\-]+$")
    if not safe_re.match(category) or not safe_re.match(object_id):
        raise HTTPException(status_code=400, detail="category and object_id must be lowercase alphanumeric/underscore/dash")
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename")
    ext = Path(file.filename).suffix.lower()
    if ext not in {".glb", ".gltf", ".svg"}:
        raise HTTPException(status_code=400, detail="Only .glb, .gltf, .svg files allowed")

    dest_dir = LIBRARY_PATH / "objects" / category / object_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_file = dest_dir / Path(file.filename).name

    contents = await file.read()
    with open(dest_file, "wb") as f:
        f.write(contents)

    return {"saved": str(dest_file.relative_to(LIBRARY_PATH)), "size": len(contents)}


@app.get("/library/{file_path:path}")
async def serve_library_file(file_path: str):
    """Serve a file from the backend library folder (IFC models, SVGs, etc.)."""
    # Security: resolve and validate path stays inside LIBRARY_PATH
    try:
        target = (LIBRARY_PATH / file_path).resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not str(target).startswith(str(LIBRARY_PATH.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"Library file not found: {file_path}")
    return FileResponse(str(target))


@app.get("/nature/{file_path:path}")
async def serve_nature_file(file_path: str):
    """Serve a file from the Ultimate Stylized Nature glTF library."""
    try:
        target = (NATURE_PATH / file_path).resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not str(target).startswith(str(NATURE_PATH.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"Nature file not found: {file_path}")
    return FileResponse(str(target))


@app.get("/api/material-config")
async def get_material_config():
    """Return the full material config from backend/materials.yaml."""
    if not MATERIALS_PATH.exists():
        raise HTTPException(status_code=404, detail="materials.yaml not found")
    try:
        with open(MATERIALS_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read materials.yaml: {e}")


@app.put("/api/material-config")
async def put_material_config(payload: dict):
    """Save updated material config back to backend/materials.yaml."""
    if "materials" not in payload and "element_defaults" not in payload:
        raise HTTPException(status_code=400, detail="Payload must contain 'materials' or 'element_defaults'")
    try:
        with open(MATERIALS_PATH, "w", encoding="utf-8") as f:
            yaml.dump(payload, f, allow_unicode=True, sort_keys=False, default_flow_style=False)
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write materials.yaml: {e}")


@app.get("/api/health")
async def health():
    data = _load()
    return {
        "status": "ok",
        "storage": "JSON file",
        "graph_file": str(GRAPH_PATH),
        "graph_exists": GRAPH_PATH.exists(),
        "nodes": len(data.get("nodes", [])),
        "edges": len(data.get("edges", [])),
    }


@app.get("/api/graph/load")
async def load():
    data = _load()
    # NOTE: this response is built field-by-field, so anything added to
    # GraphData/_save must be listed here too or it silently never reaches the
    # client — annotations/composerShapes/viewTabs were all lost this way.
    return {
        "nodes":          data.get("nodes", []),
        "edges":          data.get("edges", []),
        "buildingAxes":   data.get("buildingAxes", {"xValues": [], "yValues": []}),
        "projectName":    data.get("projectName", "My Building"),
        "activeStoreyId": data.get("activeStoreyId", None),
        "worldLocation":  data.get("worldLocation", None),
        "globeInstances": data.get("globeInstances", []),
        "annotations":    data.get("annotations", []),
        "composerShapes": data.get("composerShapes", []),
        "viewTabs":       data.get("viewTabs", []),
        "activeTabId":    data.get("activeTabId", None),
    }


@app.post("/api/graph/save")
async def save(data: GraphData):
    payload = {
        "nodes":  [n.model_dump(by_alias=True) for n in data.nodes],
        "edges":  [e.model_dump(by_alias=True) for e in data.edges],
        "buildingAxes": {
            "xValues": data.buildingAxes.xValues,
            "yValues": data.buildingAxes.yValues,
        },
        "projectName":    data.projectName,
        "activeStoreyId": data.activeStoreyId,
        "worldLocation":  data.worldLocation.model_dump() if data.worldLocation else None,
        "globeInstances": data.globeInstances,
        "annotations":    data.annotations,
        "composerShapes": data.composerShapes,
        "viewTabs":       data.viewTabs,
        "activeTabId":    data.activeTabId,
    }
    _save(payload)
    return {
        "success": True,
        "nodes":   len(data.nodes),
        "edges":   len(data.edges),
        "message": "Graph saved successfully",
    }


@app.get("/api/graph/search")
async def search(q: str):
    if not q or len(q) < 2:
        raise HTTPException(status_code=400, detail="Query too short (min 2 chars)")
    q_low   = q.lower()
    data    = _load()
    results = [
        n for n in data.get("nodes", [])
        if q_low in n.get("id",   "").lower()
        or q_low in n.get("name", "").lower()
        or q_low in json.dumps(n.get("properties", {})).lower()
    ]
    return {"query": q, "results": results, "count": len(results)}


@app.get("/api/graph/search-by-type")
async def search_by_type(type: str):
    if not type:
        raise HTTPException(status_code=400, detail="Type required")
    data    = _load()
    results = [n for n in data.get("nodes", []) if n.get("type") == type]
    return {"type": type, "results": results, "count": len(results)}


@app.get("/api/graph/stats")
async def stats():
    data  = _load()
    nodes = data.get("nodes", [])
    node_types: dict[str, int] = {}
    for n in nodes:
        t = n.get("type", "unknown")
        node_types[t] = node_types.get(t, 0) + 1
    return {
        "total_nodes": len(nodes),
        "total_edges": len(data.get("edges", [])),
        "node_types":  node_types,
        "storage":     "JSON",
    }


@app.post("/api/graph/backup")
async def create_backup(label: str = "manual"):
    timestamp   = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_name = f"graph-{timestamp}-{label}.json"
    backup_file = BACKUP_PATH / backup_name
    data        = _load()
    backup_data = {
        "timestamp":  timestamp,
        "label":      label,
        "node_count": len(data.get("nodes", [])),
        "edge_count": len(data.get("edges", [])),
        "data":       data,
    }
    with open(backup_file, "w", encoding="utf-8") as f:
        json.dump(backup_data, f, ensure_ascii=False, indent=2)
    size_kb = backup_file.stat().st_size / 1024
    print(f"Backup: {backup_name} ({size_kb:.1f} KB)")
    return {"success": True, "backup": backup_name, "size_kb": size_kb, "timestamp": timestamp}


@app.get("/api/graph/backups")
async def list_backups():
    backups     = sorted(BACKUP_PATH.glob("graph-*.json"), reverse=True)
    backup_list = []
    for b in backups[:20]:
        try:
            with open(b, "r", encoding="utf-8") as f:
                meta = json.load(f)
            backup_list.append({
                "name":       b.name,
                "size_kb":    b.stat().st_size / 1024,
                "timestamp":  meta.get("timestamp"),
                "label":      meta.get("label"),
                "node_count": meta.get("node_count"),
                "edge_count": meta.get("edge_count"),
            })
        except Exception:
            continue
    return {"total": len(list(BACKUP_PATH.glob("graph-*.json"))), "backups": backup_list}


@app.post("/api/graph/restore")
async def restore_backup(backup_name: str):
    backup_file = BACKUP_PATH / backup_name
    if not backup_file.exists():
        raise HTTPException(status_code=404, detail="Backup not found")
    with open(backup_file, "r", encoding="utf-8") as f:
        backup_data = json.load(f)
    graph = backup_data.get("data", {})
    _save(graph)
    return {
        "success":        True,
        "backup":         backup_name,
        "nodes_restored": len(graph.get("nodes", [])),
        "edges_restored": len(graph.get("edges", [])),
    }


# ─── Version history (git-like commit log — see version_history.py) ───────

@app.post("/api/graph/history/commit")
async def commit_history(message: str = "", kind: str = "manual"):
    """Commit the CURRENT saved graph state. `kind`: manual | auto | checkpoint
    | pre-ifc-import (restore is only ever produced by the restore endpoint)."""
    if kind not in ("manual", "auto", "checkpoint", "pre-ifc-import"):
        raise HTTPException(status_code=400, detail=f"Invalid kind: {kind}")
    data = _load()
    entry = history.commit(data, message, kind)  # type: ignore[arg-type]
    return {"success": True, "commit": entry}


@app.get("/api/graph/history")
async def list_history(limit: int = 50):
    return {"commits": history.list_commits(limit=limit)}


@app.get("/api/graph/history/{commit_id}")
async def get_history_commit(commit_id: int, include_content: bool = False):
    entry = history.get_commit(commit_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Commit not found")
    result = {"commit": entry}
    if include_content:
        result["content"] = history.get_content(commit_id)
    return result


@app.post("/api/graph/history/restore/{commit_id}")
async def restore_history_commit(commit_id: int):
    result = history.restore(commit_id)
    if not result:
        raise HTTPException(status_code=404, detail="Commit not found")
    _save(result["content"])
    return {
        "success":        True,
        "commit":         result["commit"],
        "nodes_restored": len(result["content"].get("nodes", [])),
        "edges_restored": len(result["content"].get("edges", [])),
    }


@app.get("/api/graph/history/diff/summary")
async def diff_history(from_id: int, to_id: int):
    diff = history.diff_summary(from_id, to_id)
    if diff is None:
        raise HTTPException(status_code=404, detail="One or both commits not found")
    return diff


@app.post("/api/graph/history/gc")
async def gc_history(keep_auto: int = 50):
    """Prune old 'auto' commit metadata beyond `keep_auto`, then reclaim any
    blobs no remaining commit references. Manual/checkpoint/restore/
    pre-ifc-import commits are never pruned."""
    pruned = history.prune_auto_commits(keep=keep_auto)
    freed = history.gc()
    return {"success": True, "pruned_commits": pruned, **freed}


@app.post("/api/graph/history/{commit_id}/comment")
async def comment_on_history_commit(commit_id: int, text: str):
    """Append a comment to a commit — does not touch its content/message/hash."""
    entry = history.add_comment(commit_id, text)
    if not entry:
        raise HTTPException(status_code=404, detail="Commit not found")
    return {"success": True, "commit": entry}


# ─── Chat / NL queries (Python dict operations, no Cypher) ────────────────

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)

class ChatResponse(BaseModel):
    reply: str
    cypher: Optional[str] = None
    results: Optional[list] = None
    action: Optional[str] = None


# ─── Ollama helpers ────────────────────────────────────────────────────────

def _ollama_reachable() -> bool:
    """Return True if the ollama library is installed AND the server responds."""
    if not _OLLAMA_AVAILABLE or _ollama_lib is None:
        return False
    try:
        client = _ollama_lib.Client(host=OLLAMA_BASE_URL)
        client.list()  # raises if server is down
        return True
    except Exception:
        return False


def _build_graph_context() -> str:
    """Build a short summary of the current graph to inject into the system prompt."""
    data  = _load()
    nodes: list[dict] = data.get("nodes", [])
    edges: list[dict] = data.get("edges", [])
    types: dict[str, int] = {}
    for n in nodes:
        t = n.get("type", "?")
        types[t] = types.get(t, 0) + 1
    type_summary = ", ".join(f"{k}: {v}" for k, v in sorted(types.items()))
    return (
        f"Project: {data.get('projectName', 'My Building')}\n"
        f"Graph nodes: {len(nodes)} | Graph edges: {len(edges)}\n"
        f"Node types: {type_summary or 'none'}"
    )


_OLLAMA_SYSTEM = """\
You are BubbleGraph AI, an expert BIM (Building Information Modeling) assistant \
embedded in the BubbleGraph application (similar to ArchiCAD / Revit).
You help users understand their building project data stored as a relational graph.

Current project context:
{graph_context}

Rules:
- Answer in the SAME language the user uses (Romanian or English).
- Be concise — prefer bullet points for lists.
- If the user asks for graph data (counts, lists, search), tell them to use commands \
like "câte noduri?", "statistici", 'listează storeys', or "cauta nod \\"id\\"".
- For general BIM / architectural questions, answer directly.
- Never fabricate specific node IDs or property values — you can only see the summary above.
"""


def _chat_ollama(msg: str, history: list[dict]) -> str:
    """
    Send msg + history to ollama phi3 and return the reply text.
    Raises RuntimeError if ollama is unavailable or the call fails.
    """
    if not _OLLAMA_AVAILABLE or _ollama_lib is None:
        raise RuntimeError("ollama library not installed")

    system_prompt = _OLLAMA_SYSTEM.format(graph_context=_build_graph_context())

    messages_payload = [{"role": "system", "content": system_prompt}]
    for h in history[-10:]:  # keep last 10 turns for context window
        messages_payload.append({"role": h["role"], "content": h["content"]})
    messages_payload.append({"role": "user", "content": msg})

    try:
        client   = _ollama_lib.Client(host=OLLAMA_BASE_URL)
        response = client.chat(model=OLLAMA_MODEL, messages=messages_payload)
        return response["message"]["content"].strip()
    except Exception as exc:
        raise RuntimeError(f"ollama error: {exc}") from exc


_INTENT_PATTERNS: list[tuple] = [
    (re.compile(r'\b(cate|how many|count)\b.*\b(noduri|node|nod)',          re.I), "count_nodes"),
    (re.compile(r'\b(cate|how many|count)\b.*\b(edge|muchii|relat)',         re.I), "count_edges"),
    (re.compile(r'\b(list|arata|show|afis).*\b(toate|all)?\b.*\b(noduri|node)', re.I), "list_nodes"),
    (re.compile(r'\b(storey|etaj|storie|floor)',                             re.I), "list_storeys"),
    (re.compile(r'\b(type|tip)[:\s]+[\'"]?(\w+)[\'"]?',                     re.I), "search_type"),
    (re.compile(r'\b(find|cauta|search|gaseste)\b.*[\'\"](.*?)[\'\"]',      re.I), "search_name"),
    (re.compile(r'\b(delete|sterge|remove)\b.*\b(node|nod)\b.*[\'\"](.*?)[\'\"]', re.I), "delete_node"),
    (re.compile(r'\b(stat|statistic|rezumat|summary|overview)',              re.I), "stats"),
    (re.compile(r'\b(help|ajutor|ce poti|what can)',                         re.I), "help"),
]


def _chat_execute(action: str, match, msg: str):
    """Execute a chat intent against the JSON store. Returns (raw_rows, reply_text)."""
    data  = _load()
    nodes: list[dict] = data.get("nodes", [])
    edges: list[dict] = data.get("edges", [])

    if action == "help":
        return [], (
            "Pot sa te ajut cu:\n"
            "* **Interogari**: 'cate noduri sunt?', 'listeaza nodurile', 'arata storeys'\n"
            "* **Cautare**: 'cauta nod \"space1\"', 'noduri de tip wall'\n"
            "* **Statistici**: 'statistici', 'rezumat'\n"
            "* **Stergere**: 'sterge nod \"node_abc\"'\n\n"
            "Poti scrie in romana sau engleza."
        )

    if action == "stats":
        types: dict[str, int] = {}
        for n in nodes:
            t = n.get("type", "?")
            types[t] = types.get(t, 0) + 1
        summary = "\n".join(f"  * {k}: {v}" for k, v in sorted(types.items()))
        return [], (
            f"**Statistici graf:**\n"
            f"* Noduri totale: **{len(nodes)}**\n"
            f"* Muchii totale: **{len(edges)}**\n"
            f"* Tipuri:\n{summary or '  (niciuna)'}"
        )

    if action == "count_nodes":
        return [[len(nodes)]], f"Exista **{len(nodes)}** noduri in graf."

    if action == "count_edges":
        return [[len(edges)]], f"Exista **{len(edges)}** muchii in graf."

    if action == "list_nodes":
        rows  = [[n["id"], n.get("type", "?"), n.get("x", 0), n.get("y", 0)] for n in nodes[:50]]
        lines = [f"* `{r[0]}` (tip: **{r[1]}**)" for r in rows[:20]]
        return rows, f"**{len(nodes)}** noduri:\n" + "\n".join(lines)

    if action == "list_storeys":
        storeys = [n for n in nodes if n.get("type") == "storey"]
        rows    = [[n["id"], "storey"] for n in storeys]
        lines   = [f"* `{n['id']}` -- {n.get('name', '')}" for n in storeys]
        return rows, (f"**{len(storeys)}** etaje:\n" + "\n".join(lines)) if storeys else "Nu exista etaje."

    if action == "search_type":
        tm = re.search(r"(?:type|tip)[:\s]+['\"]?(\w+)['\"]?", msg, re.I)
        node_type = tm.group(1) if tm else (match.group(0) if match else "")
        found = [n for n in nodes if n.get("type") == node_type]
        rows  = [[n["id"], n.get("type"), n.get("x", 0), n.get("y", 0)] for n in found[:50]]
        lines = [f"* `{n['id']}`" for n in found[:20]]
        return rows, (f"**{len(found)}** noduri de tip '{node_type}':\n" + "\n".join(lines)) if found \
            else f"Nu am gasit noduri de tip '{node_type}'."

    if action == "search_name":
        term  = (match.group(2) if match and match.lastindex and match.lastindex >= 2 else msg).lower()
        found = [
            n for n in nodes
            if term in n.get("id",   "").lower()
            or term in n.get("name", "").lower()
            or term in json.dumps(n.get("properties", {})).lower()
        ]
        rows  = [[n["id"], n.get("type"), n.get("x", 0), n.get("y", 0)] for n in found[:20]]
        lines = [f"* `{r[0]}` tip={r[1]}" for r in rows]
        return rows, ("Rezultate:\n" + "\n".join(lines)) if rows else "Nu am gasit niciun nod."

    if action == "delete_node":
        node_id = match.group(3) if match and match.lastindex and match.lastindex >= 3 else None
        if not node_id:
            return [], "Nu am putut identifica id-ul. Specifica intre ghilimele: sterge nod \"node_abc\"."
        new_nodes = [n for n in nodes if n["id"] != node_id]
        new_edges = [e for e in edges if e.get("from") != node_id and e.get("to") != node_id]
        if len(new_nodes) == len(nodes):
            return [], f"Nodul `{node_id}` nu a fost gasit."
        _save({**data, "nodes": new_nodes, "edges": new_edges})
        return [], f"Nodul `{node_id}` a fost sters."

    return [], "Comanda necunoscuta. Scrie 'help' pentru lista de comenzi."


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    msg = req.message.strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Empty message")

    # Direct Cypher is no longer supported -- politely explain
    if re.match(r'^\s*(MATCH|CREATE|DELETE|MERGE|WITH|CALL)\b', msg, re.I):
        return ChatResponse(
            reply=(
                "Cypher direct nu mai este disponibil (backend migrat la JSON simplu).\n"
                "Foloseste comenzi naturale: 'cate noduri?', 'arata storeys', 'statistici'. "
                "Scrie **help** pentru lista completa."
            ),
            action="info",
        )

    action  = "unknown"
    matched = None
    for pattern, intent in _INTENT_PATTERNS:
        m = pattern.search(msg)
        if m:
            action, matched = intent, m
            break

    if action == "unknown":
        # Try ollama phi3 before falling back to search_name
        if _ollama_reachable():
            try:
                history_dicts = [{"role": h.role, "content": h.content} for h in req.history]
                reply = _chat_ollama(msg, history_dicts)
                return ChatResponse(reply=reply, action="ollama")
            except RuntimeError:
                pass  # fall through to search_name
        action = "search_name"

    raw_results, reply = _chat_execute(action, matched, msg)
    return ChatResponse(reply=reply, results=raw_results or None, action=action)


@app.get("/api/chat/status")
async def chat_status():
    """Return whether ollama is reachable and which model is configured."""
    reachable = _ollama_reachable()
    return {
        "ollama": reachable,
        "model":  OLLAMA_MODEL if reachable else None,
        "base_url": OLLAMA_BASE_URL,
    }


# ─── DXF / bglib symbol library endpoints ────────────────────────────────────

def _get_dxf_parser():
    """Lazy import so the app still starts without ezdxf."""
    try:
        from library.dxf_parser import parse_dxf_symbol, save_bglib_json, scan_library_for_bglib
        return parse_dxf_symbol, save_bglib_json, scan_library_for_bglib
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=f"ezdxf not installed: {exc}")


@app.get("/api/library/bglib/symbols")
async def list_bglib_symbols(element_type: str = Query(default=None, description="Filter by element type, e.g. 'window'")):
    """Return metadata for all .bglib.json files in the library folder."""
    try:
        _, _, scan = _get_dxf_parser()
    except HTTPException:
        scan = None

    results = []
    for root, _dirs, files in os.walk(str(LIBRARY_PATH)):
        for fname in files:
            if not fname.endswith(".bglib.json"):
                continue
            full = Path(root) / fname
            try:
                with open(full, "r", encoding="utf-8") as f:
                    data = json.load(f)
                rel = full.relative_to(LIBRARY_PATH).as_posix()
                parts = rel.split("/")
                etype = parts[0].rstrip("s") if parts else "window"
                if element_type and etype != element_type:
                    continue
                results.append({
                    "name":          data.get("name", fname[:-12]),
                    "file":          rel,
                    "elementType":   etype,
                    "defaultWidth":  data.get("defaultWidth", 1000),
                    "defaultHeight": data.get("defaultHeight", 200),
                    "sliderCount":   len(data.get("sliders", [])),
                })
            except Exception:
                pass
    return {"symbols": results}


@app.get("/api/library/bglib/symbol/{file_path:path}")
async def get_bglib_symbol(file_path: str):
    """Return the full .bglib.json content for a symbol."""
    try:
        target = (LIBRARY_PATH / file_path).resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not str(target).startswith(str(LIBRARY_PATH.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if not target.is_file() or not target.name.endswith(".bglib.json"):
        raise HTTPException(status_code=404, detail="Symbol not found")
    with open(target, "r", encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/library/bglib/parse-dxf")
async def parse_dxf_upload(
    element_type: str = Query(default="window", description="window | door | wall …"),
    file: UploadFile = File(...),
):
    """
    Upload a .dxf file, parse it with dxf_parser, save .bglib.json to the
    appropriate library sub-folder, and return the parsed symbol JSON.
    """
    parse_fn, save_fn, _ = _get_dxf_parser()

    # Validate upload
    if not file.filename or not file.filename.lower().endswith(".dxf"):
        raise HTTPException(status_code=400, detail="Only .dxf files accepted")

    # Sanitize filename
    safe_name = re.sub(r"[^a-zA-Z0-9_\-\.]", "_", Path(file.filename).stem)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Validate element_type
    allowed_types = {"window", "door", "wall", "beam", "column", "slab", "foundation"}
    if element_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Unsupported element_type '{element_type}'")

    # Write DXF to temp file
    contents = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        symbol_data = parse_fn(tmp_path)
        symbol_data["name"] = safe_name  # use sanitized upload filename
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"DXF parse error: {exc}")
    finally:
        os.unlink(tmp_path)

    # Save .bglib.json to library folder
    dest_dir = LIBRARY_PATH / f"{element_type}s" / "default"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_file = dest_dir / f"{safe_name}.bglib.json"
    with open(dest_file, "w", encoding="utf-8") as f:
        json.dump(symbol_data, f, indent=2, ensure_ascii=False)

    return {
        "saved": dest_file.relative_to(LIBRARY_PATH).as_posix(),
        "symbol": symbol_data,
    }


# ─── Auto-symbol endpoints (symbols2d/ folder, name-based mapping) ────────────

@app.get("/api/library/bglib/auto-symbols")
async def list_auto_symbols(
    element_type: str = Query(default="window", description="window | door | …"),
):
    """
    List available auto-symbols for an element type.
    Scans backend/library/{element_type}s/symbols2d/ for .dxf files.
    """
    safe_re = re.compile(r"^[a-z]+$")
    if not safe_re.match(element_type):
        raise HTTPException(status_code=400, detail="Invalid element_type")
    folder = LIBRARY_PATH / f"{element_type}s" / "symbols2d"
    if not folder.exists():
        return {"symbols": [], "folder": f"{element_type}s/symbols2d"}
    results = []
    for f in sorted(folder.iterdir()):
        if f.suffix.lower() == ".dxf":
            bglib_path = f.with_suffix(".bglib.json")
            results.append({
                "typeId":   f.stem,
                "dxfFile":  f.name,
                "hasBglib": bglib_path.exists(),
            })
    return {"symbols": results, "folder": f"{element_type}s/symbols2d"}


@app.get("/api/library/bglib/auto-symbol/{element_type}/{type_id}")
async def get_auto_symbol(element_type: str, type_id: str):
    """
    Return (auto-parsing if needed) the bglib.json for a specific type ID.
    Looks for backend/library/{element_type}s/symbols2d/{type_id}.dxf.
    On first call, parses the DXF and caches the .bglib.json beside it.
    """
    safe_re = re.compile(r"^[a-zA-Z0-9_\-]+$")
    if not safe_re.match(element_type) or not safe_re.match(type_id):
        raise HTTPException(status_code=400, detail="Invalid parameters")

    folder = LIBRARY_PATH / f"{element_type}s" / "symbols2d"
    bglib_path = folder / f"{type_id}.bglib.json"
    dxf_path   = folder / f"{type_id}.dxf"

    # Serve cached bglib.json only if DXF has NOT changed since it was generated.
    # If DXF mtime > bglib mtime, force re-parse so edits to the DXF are reflected immediately.
    if bglib_path.exists():
        dxf_mtime   = dxf_path.stat().st_mtime if dxf_path.exists() else 0
        bglib_mtime = bglib_path.stat().st_mtime
        if bglib_mtime >= dxf_mtime:
            with open(bglib_path, "r", encoding="utf-8") as f:
                return json.load(f)
        # DXF is newer — fall through to re-parse below

    # Auto-parse from .dxf
    if dxf_path.exists():
        parse_fn, _, _ = _get_dxf_parser()
        try:
            data = parse_fn(str(dxf_path))
            data["name"] = type_id
            with open(bglib_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return data
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"DXF parse error: {exc}")

    raise HTTPException(status_code=404, detail=f"No symbol for {element_type}/{type_id}")


# ── IFC Import ───────────────────────────────────────────────────────────────

_IFC_TO_BBIM_SYSTEM = """\
You are a BIM parametric modeler. Convert IFC-extracted wall/opening data into a BubbleGraph \
relational graph (nodes + edges JSON).

BubbleGraph rules:
- Node types: storey, ax, wall, window, door, room
- Storey node: id="storey_0", type="storey", name=<storeyName>, x=0, y=0, parentId=null
  properties: { bottomElevation: <mm>, topElevation: <mm>, axesX: [<mm>,...], axesY: [<mm>,...] }
- Ax node: id="ax_<gx>_<gy>", type="ax", name="<gx+1>-<letter>", x=<canvas_x>, y=<canvas_y>, parentId="storey_0"
  properties: { gridX: <int>, gridY: <int>, axNodeIndex: <gy*xCount+gx> }
  Canvas x = axesX[gx]*0.1 (scale down for canvas), canvas y = -axesY[gy]*0.1
- Wall node: id="wall_<n>", type="wall", name="Wall<n>", x=<midpoint_x*0.1>, y=<-midpoint_y*0.1>, parentId="storey_0"
  properties: { wall_type: "W<thickness_cm>", has_windows: "False", windows: "[]", has_doors: "False", doors: "[]" }
  If wall has openings, set has_windows/has_doors="True" and fill windows/doors JSON arrays.
- Window inline: {"id":"inl_win_<n>","window_type":"W-FIX-<widthCm>x<heightCm>","width":<mm>,"height":<mm>,"sill_height":<mm>,"wall_offset":0,"count":1,"spacing":0,"opening":"single","flip_across":false}
- Door inline: {"id":"inl_door_<n>","door_type":"D-SLD-<widthCm>x<heightCm>","width":<mm>,"height":<mm>,"sill_height":0,"wall_offset":0,"count":1}
- Edges: wall→ax (2 per wall, one for each endpoint ax node), type="wall-connection"
  Edge id format: "e_<wallId>_<axId>"
  Snap wall startPt/endPt to nearest ax node using axesX[gridX], axesY[gridY].

Output ONLY valid compact JSON with no explanation:
{"nodes":[...],"edges":[...]}
"""

IFC_UPLOAD_PATH = Path(__file__).parent / "uploads"
IFC_UPLOAD_PATH.mkdir(exist_ok=True)


def _llm_parametrize_ifc(parsed: dict) -> dict:
    """Call Ollama to convert parsed IFC data into BubbleGraph nodes+edges."""
    if not _OLLAMA_AVAILABLE or _ollama_lib is None:
        raise RuntimeError("Ollama not available")

    user_msg = (
        f"Convert this IFC storey data to BubbleGraph JSON:\n\n"
        f"```json\n{json.dumps(parsed, indent=2)}\n```"
    )

    client = _ollama_lib.Client(host=OLLAMA_BASE_URL)
    response = client.chat(
        model=OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": _IFC_TO_BBIM_SYSTEM},
            {"role": "user",   "content": user_msg},
        ],
        options={"temperature": 0.1, "num_predict": 8192},
    )
    raw = response["message"]["content"].strip()
    # Strip markdown code fences if present
    raw = re.sub(r'^```[a-z]*\n?', '', raw)
    raw = re.sub(r'\n?```$', '', raw)
    return json.loads(raw)


@app.post("/api/ifc/upload")
async def ifc_upload(file: UploadFile = File(...)):
    """Upload an IFC file to backend/uploads/ and return its server path key."""
    if not file.filename or not file.filename.lower().endswith('.ifc'):
        raise HTTPException(status_code=400, detail="Only .ifc files accepted")
    safe_name = re.sub(r'[^\w\-.]', '_', Path(file.filename).name)
    dest = IFC_UPLOAD_PATH / safe_name
    contents = await file.read()
    if len(contents) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 100 MB)")
    with open(dest, "wb") as f:
        f.write(contents)
    return {"fileKey": safe_name, "size": len(contents)}


class IFCParseRequest(BaseModel):
    fileKey: str
    storeyName: Optional[str] = None
    storeyIndex: int = 0
    llmParametrize: bool = True


@app.post("/api/ifc/parse-storey")
async def ifc_parse_storey(body: IFCParseRequest):
    """Phase 1+2: Parse storey from uploaded IFC, optionally LLM-parametrize."""
    if not _IFC_PARSER_AVAILABLE or _parse_ifc_storey is None:
        raise HTTPException(status_code=503, detail="IFC parser module unavailable")
    safe_re = re.compile(r'^[\w\-. ]+\.ifc$', re.IGNORECASE)
    if not safe_re.match(body.fileKey):
        raise HTTPException(status_code=400, detail="Invalid fileKey")
    ifc_path = IFC_UPLOAD_PATH / body.fileKey
    if not ifc_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.fileKey}")
    try:
        parsed = _parse_ifc_storey(
            str(ifc_path),
            storey_name=body.storeyName or None,
            storey_index=body.storeyIndex,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"IFC parse error: {exc}")

    if body.llmParametrize:
        try:
            graph = _llm_parametrize_ifc(parsed)
            return {"parsed": parsed, "graph": graph, "llmUsed": True}
        except Exception as exc:
            return {"parsed": parsed, "graph": None, "llmUsed": False, "llmError": str(exc)}

    return {"parsed": parsed, "graph": None, "llmUsed": False}


@app.post("/api/ifc/commit-graph")
async def ifc_commit_graph(body: dict):
    """Phase 3: Merge LLM-generated nodes/edges into the current graph."""
    new_nodes: list[dict] = body.get("nodes", [])
    new_edges: list[dict] = body.get("edges", [])
    if not new_nodes:
        raise HTTPException(status_code=400, detail="No nodes provided")
    timestamp   = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_name = f"graph-{timestamp}-pre-ifc-import.json"
    current     = _load()
    with open(BACKUP_PATH / backup_name, "w", encoding="utf-8") as f:
        json.dump({"timestamp": timestamp, "label": "pre-ifc-import", "data": current}, f)
    history.commit(current, "Before IFC import", "pre-ifc-import")  # also in the new commit log
    existing_node_ids = {n["id"] for n in current.get("nodes", [])}
    existing_edge_ids = {e["id"] for e in current.get("edges", [])}
    added_nodes = [n for n in new_nodes if n.get("id") not in existing_node_ids]
    added_edges = [e for e in new_edges if e.get("id") not in existing_edge_ids]
    current.setdefault("nodes", []).extend(added_nodes)
    current.setdefault("edges", []).extend(added_edges)
    _save(current)
    return {
        "success": True, "addedNodes": len(added_nodes), "addedEdges": len(added_edges),
        "skippedNodes": len(new_nodes) - len(added_nodes), "backup": backup_name,
    }


# ── IFC Plan View — all storeys wall footprints ───────────────────────────

class IFCPlanRequest(BaseModel):
    fileKey: str


@app.post("/api/ifc/plan")
async def ifc_plan(body: IFCPlanRequest):
    """Return 2-D plan data (all storeys, all wall footprints) for IFCPlanView."""
    if not _IFC_PARSER_AVAILABLE or _parse_ifc_plan is None:
        raise HTTPException(status_code=503, detail="IFC parser not available")
    ifc_path = IFC_UPLOAD_PATH / body.fileKey
    if not ifc_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {body.fileKey}")
    try:
        data = _parse_ifc_plan(str(ifc_path))
        return {"success": True, **data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc



class WallFootprintRequest(BaseModel):
    nodes: list[dict] = Field(default_factory=list)
    edges: list[dict] = Field(default_factory=list)


@app.post("/api/geometry/wall-footprints")
async def geometry_wall_footprints(body: WallFootprintRequest):
    """Compute joined wall plan footprints using Shapely extension/boolean method.

    Each wall is extended by half its thickness at junctions where ≥ 2 walls
    meet, then all meeting wall polygons are unioned and clipped back to each
    wall's directional strip.  This gives clean L / T / + joins without any
    bisector angle maths.

    Returns a list of wall footprint records with 2-D plan polygon (mm) and
    elevation data ready for extrusion in the 3-D viewer.
    """
    if not _SHAPELY_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Shapely is not installed — run: pip install shapely",
        )
    try:
        result = _compute_wall_footprints(body.nodes, body.edges)
        return {"walls": result, "count": len(result)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/geometry/status")
async def geometry_status():
    """Check which geometry backends are available."""
    return {
        "shapely": _SHAPELY_AVAILABLE,
    }


if __name__ == "__main__":
    import uvicorn
    free_port(BACKEND_PORT)
    uvicorn.run("main:app", host="0.0.0.0", port=BACKEND_PORT, reload=False)
