"""
version_history.py — content-addressable commit history for the bubble-graph
JSON state ("git-like" versioning).

Storage:
  backend/objects/<hash[:2]>/<hash>.json   Content-addressable blobs (the
                                            full graph JSON, deduped by the
                                            sha256 of its canonical form —
                                            two saves with identical content
                                            share one blob on disk instead of
                                            duplicating it, unlike the old
                                            backups/ folder's one-full-copy-
                                            per-timestamp scheme).
  backend/history.json                     The commit log: small metadata
                                            records pointing at a blob hash.
                                            A LINEAR chain (no branching) —
                                            this is a single-user local
                                            design tool, not a shared repo;
                                            branching would add real
                                            complexity for no matching value
                                            here.

A commit never mutates or removes another commit. `restore()` APPENDS a new
commit whose content matches the target instead of rewriting history — a
misclicked restore can never destroy anything already in the log (closer to
`git revert` than `git reset --hard`, deliberately — see README section this
module's docstring links to in the History panel).

Only explicit `gc()` reclaims disk space (deletes blobs no live commit
references any more), and `prune_auto_commits()` drops old low-value 'auto'
commit METADATA (manual/checkpoint/restore/pre-ifc-import commits are never
auto-pruned) — together these replace the old backup system's unbounded
growth (it kept every timestamped full copy forever; 226 files / 17MB at the
time this module was written) with a bounded, explicit retention policy.
"""

import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Literal

CommitKind = Literal["manual", "auto", "checkpoint", "restore", "pre-ifc-import"]

# Kinds that are always kept — never dropped by prune_auto_commits().
_DURABLE_KINDS = {"manual", "checkpoint", "restore", "pre-ifc-import"}


class VersionHistory:
    def __init__(self, root: Path):
        self.objects_path = root / "objects"
        self.history_path = root / "history.json"
        self.objects_path.mkdir(exist_ok=True)

    # ── content-addressable blob storage ───────────────────────────────────

    @staticmethod
    def _hash(data: dict) -> str:
        canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _blob_path(self, content_hash: str) -> Path:
        return self.objects_path / content_hash[:2] / f"{content_hash}.json"

    def _write_blob(self, data: dict) -> str:
        content_hash = self._hash(data)
        path = self._blob_path(content_hash)
        if not path.exists():  # dedup: identical content is never written twice
            path.parent.mkdir(exist_ok=True)
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            tmp.replace(path)
        return content_hash

    def _read_blob(self, content_hash: str) -> dict:
        with open(self._blob_path(content_hash), "r", encoding="utf-8") as f:
            return json.load(f)

    # ── commit log ────────────────────────────────────────────────────────

    def _load_log(self) -> list:
        if not self.history_path.exists():
            return []
        try:
            with open(self.history_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_log(self, log: list) -> None:
        tmp = self.history_path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(log, f, ensure_ascii=False, indent=2)
        tmp.replace(self.history_path)

    def commit(self, data: dict, message: str = "", kind: CommitKind = "manual") -> dict:
        """Record `data` as a new commit. No-op (returns the existing HEAD
        commit unchanged) when `data` is byte-identical to HEAD's content AND
        this isn't a checkpoint/restore — those are meaningful even with
        unchanged content (the user explicitly marked this point, or a
        restore should always be visible in the log)."""
        log = self._load_log()
        content_hash = self._write_blob(data)
        if log and log[-1]["hash"] == content_hash and kind not in ("checkpoint", "restore"):
            return log[-1]
        parent = log[-1]["id"] if log else None
        commit_id = (log[-1]["id"] + 1) if log else 1
        entry = {
            "id": commit_id,
            "hash": content_hash,
            "parent": parent,
            "message": message,
            "kind": kind,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "node_count": len(data.get("nodes", [])),
            "edge_count": len(data.get("edges", [])),
            "comments": [],
        }
        log.append(entry)
        self._save_log(log)
        return entry

    def list_commits(self, limit: Optional[int] = None) -> list:
        """Newest first."""
        log = list(reversed(self._load_log()))
        return log[:limit] if limit else log

    def get_commit(self, commit_id: int) -> Optional[dict]:
        for entry in self._load_log():
            if entry["id"] == commit_id:
                return entry
        return None

    def add_comment(self, commit_id: int, text: str) -> Optional[dict]:
        """Append a comment to an existing commit WITHOUT touching its content,
        message, or hash — a note added after the fact (e.g. "this is where I
        switched to concrete slabs"), same idea as a GitHub commit comment.
        Returns the updated commit entry, or None if commit_id doesn't exist."""
        text = text.strip()
        if not text:
            return self.get_commit(commit_id)
        log = self._load_log()
        for entry in log:
            if entry["id"] == commit_id:
                entry.setdefault("comments", []).append({
                    "text": text,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                self._save_log(log)
                return entry
        return None

    def get_content(self, commit_id: int) -> Optional[dict]:
        entry = self.get_commit(commit_id)
        return self._read_blob(entry["hash"]) if entry else None

    def restore(self, commit_id: int) -> Optional[dict]:
        """Append a NEW commit carrying the target commit's content. Returns
        {"commit": <new log entry>, "content": <the restored graph>}, or None
        if commit_id doesn't exist. Never rewrites or removes history."""
        entry = self.get_commit(commit_id)
        if not entry:
            return None
        content = self._read_blob(entry["hash"])
        label = entry["message"] or f"commit #{entry['id']}"
        new_entry = self.commit(content, f"Restored: {label}", kind="restore")
        return {"commit": new_entry, "content": content}

    # ── retention ─────────────────────────────────────────────────────────

    def prune_auto_commits(self, keep: int = 50) -> int:
        """Drop old 'auto' commit metadata beyond the most recent `keep`
        (durable kinds are never touched). Returns how many were dropped.
        Does NOT free disk space by itself — call gc() after to reclaim any
        blobs that were only referenced by the dropped commits."""
        log = self._load_log()
        auto_ids_newest_first = [e["id"] for e in reversed(log) if e["kind"] == "auto"]
        drop_ids = set(auto_ids_newest_first[keep:])
        if not drop_ids:
            return 0
        self._save_log([e for e in log if e["id"] not in drop_ids])
        return len(drop_ids)

    def gc(self) -> dict:
        """Delete every blob under objects/ that no remaining commit references."""
        referenced = {e["hash"] for e in self._load_log()}
        freed_bytes = 0
        freed_count = 0
        for blob_file in self.objects_path.glob("*/*.json"):
            if blob_file.stem not in referenced:
                freed_bytes += blob_file.stat().st_size
                blob_file.unlink()
                freed_count += 1
        for sub in self.objects_path.iterdir():
            if sub.is_dir() and not any(sub.iterdir()):
                sub.rmdir()
        return {"freed_count": freed_count, "freed_bytes": freed_bytes}

    # ── diff ──────────────────────────────────────────────────────────────

    def diff_summary(self, from_id: int, to_id: int) -> Optional[dict]:
        """Node/edge-level diff between two commits: which ids were added,
        removed, or changed — NOT a raw JSON text diff (far more useful for
        a graph structure). Returns None if either commit id doesn't exist."""
        a = self.get_content(from_id)
        b = self.get_content(to_id)
        if a is None or b is None:
            return None

        a_nodes = {n["id"]: n for n in a.get("nodes", [])}
        b_nodes = {n["id"]: n for n in b.get("nodes", [])}
        a_edges = {e["id"]: e for e in a.get("edges", [])}
        b_edges = {e["id"]: e for e in b.get("edges", [])}

        return {
            "nodes": {
                "added":    sorted(i for i in b_nodes if i not in a_nodes),
                "removed":  sorted(i for i in a_nodes if i not in b_nodes),
                "modified": sorted(i for i in b_nodes if i in a_nodes and a_nodes[i] != b_nodes[i]),
            },
            "edges": {
                "added":   sorted(i for i in b_edges if i not in a_edges),
                "removed": sorted(i for i in a_edges if i not in b_edges),
            },
        }
