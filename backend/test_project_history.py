"""
test_project_history.py — end-to-end tests for the per-project version
history routes added to auth_routes.py (POST/GET /api/projects/{id}/history/*).

Uses a temp BUBBLEBIM_DATA_DIR (set BEFORE importing auth_db/main, since
DATA_DIR is resolved once at import time) so this never touches the real
SQLite db or the real project_history/ directory, and a fresh FastAPI
TestClient hitting the real app + real auth flow (register → login → bearer
token) — not mocked, the same JWT check every real request goes through.

Run with:  backend/.venv/bin/python -m unittest test_project_history -v
"""

import os
import shutil
import tempfile
import unittest

_TMP_DATA_DIR = tempfile.mkdtemp(prefix="bbim_test_data_")
os.environ["BUBBLEBIM_DATA_DIR"] = _TMP_DATA_DIR

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402  (imports auth_db, which reads BUBBLEBIM_DATA_DIR at import time)

# TestClient must be entered as a context manager to run the app's lifespan
# (which calls auth_db.init_db() to create the users/projects tables) —
# a bare TestClient(app) never triggers ASGI startup.
client = TestClient(app)


def setUpModule():
    client.__enter__()


def tearDownModule():
    client.__exit__(None, None, None)
    shutil.rmtree(_TMP_DATA_DIR, ignore_errors=True)


def _register_and_login(username: str) -> str:
    client.post("/api/auth/register", json={"username": username, "password": "pw12345"})
    res = client.post("/api/auth/login", json={"username": username, "password": "pw12345"})
    return res.json()["token"]


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_project(token: str, name: str = "Test Project") -> str:
    res = client.post("/api/projects", json={"name": name}, headers=_auth_headers(token))
    return res.json()["project"]["id"]


class ProjectHistoryTest(unittest.TestCase):
    def setUp(self):
        # Unique username per test so they don't collide in the shared temp SQLite db.
        self.token = _register_and_login(f"user_{self._testMethodName}")
        self.project_id = _create_project(self.token)

    def test_commit_then_list(self):
        res = client.post(
            f"/api/projects/{self.project_id}/history/commit",
            params={"message": "Baseline", "kind": "manual"},
            headers=_auth_headers(self.token),
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["commit"]["id"], 1)

        res = client.get(f"/api/projects/{self.project_id}/history", headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 200)
        commits = res.json()["commits"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["message"], "Baseline")

    def test_history_is_isolated_per_project(self):
        other_project_id = _create_project(self.token, "Second Project")
        client.post(f"/api/projects/{self.project_id}/history/commit",
                    params={"message": "A"}, headers=_auth_headers(self.token))
        client.post(f"/api/projects/{other_project_id}/history/commit",
                    params={"message": "B"}, headers=_auth_headers(self.token))

        a = client.get(f"/api/projects/{self.project_id}/history", headers=_auth_headers(self.token)).json()["commits"]
        b = client.get(f"/api/projects/{other_project_id}/history", headers=_auth_headers(self.token)).json()["commits"]
        self.assertEqual([c["message"] for c in a], ["A"])
        self.assertEqual([c["message"] for c in b], ["B"])

    def test_another_users_project_is_forbidden(self):
        other_token = _register_and_login(f"other_{self._testMethodName}")
        res = client.get(f"/api/projects/{self.project_id}/history", headers=_auth_headers(other_token))
        self.assertEqual(res.status_code, 403)

    def test_unauthenticated_request_is_rejected(self):
        res = client.get(f"/api/projects/{self.project_id}/history")
        self.assertEqual(res.status_code, 401)

    def test_unknown_project_is_404(self):
        res = client.get("/api/projects/does-not-exist/history", headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 404)

    def test_restore_applies_content_via_the_real_project_save_path(self):
        client.put(f"/api/projects/{self.project_id}", json={
            "nodes": [{"id": "n1", "type": "wall", "x": 0, "y": 0, "properties": {}}],
            "edges": [], "buildingAxes": {"xValues": [], "yValues": []},
        }, headers=_auth_headers(self.token))
        c1 = client.post(f"/api/projects/{self.project_id}/history/commit",
                          params={"message": "one node"}, headers=_auth_headers(self.token)).json()["commit"]

        client.put(f"/api/projects/{self.project_id}", json={
            "nodes": [], "edges": [], "buildingAxes": {"xValues": [], "yValues": []},
        }, headers=_auth_headers(self.token))
        client.post(f"/api/projects/{self.project_id}/history/commit",
                    params={"message": "emptied"}, headers=_auth_headers(self.token))

        res = client.post(f"/api/projects/{self.project_id}/history/restore/{c1['id']}", headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["nodes_restored"], 1)

        # The actual project row (read via the normal GET /projects/{id} path) now has the node back.
        current = client.get(f"/api/projects/{self.project_id}", headers=_auth_headers(self.token)).json()
        self.assertEqual(len(current["nodes"]), 1)

        # Nothing was deleted from the log — restore appended a 3rd commit.
        commits = client.get(f"/api/projects/{self.project_id}/history", headers=_auth_headers(self.token)).json()["commits"]
        self.assertEqual(len(commits), 3)
        self.assertEqual(commits[0]["kind"], "restore")

    def test_diff_and_comment_round_trip(self):
        client.put(f"/api/projects/{self.project_id}", json={
            "nodes": [{"id": "n1", "type": "wall", "x": 0, "y": 0, "properties": {}}],
            "edges": [], "buildingAxes": {"xValues": [], "yValues": []},
        }, headers=_auth_headers(self.token))
        c1 = client.post(f"/api/projects/{self.project_id}/history/commit",
                          params={"message": "a"}, headers=_auth_headers(self.token)).json()["commit"]

        client.put(f"/api/projects/{self.project_id}", json={
            "nodes": [{"id": "n1", "type": "wall", "x": 0, "y": 0, "properties": {}},
                      {"id": "n2", "type": "column", "x": 0, "y": 0, "properties": {}}],
            "edges": [], "buildingAxes": {"xValues": [], "yValues": []},
        }, headers=_auth_headers(self.token))
        c2 = client.post(f"/api/projects/{self.project_id}/history/commit",
                          params={"message": "b"}, headers=_auth_headers(self.token)).json()["commit"]

        diff = client.get(f"/api/projects/{self.project_id}/history/diff/summary",
                           params={"from_id": c1["id"], "to_id": c2["id"]},
                           headers=_auth_headers(self.token)).json()
        self.assertEqual(diff["nodes"]["added"], ["n2"])

        res = client.post(f"/api/projects/{self.project_id}/history/{c1['id']}/comment",
                           params={"text": "left this alone"}, headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["commit"]["comments"][0]["text"], "left this alone")

    def test_gc(self):
        # Content must actually differ each time — commit() is a no-op on unchanged
        # content (dedup), so identical auto-saves would never produce 3 real commits.
        for i in range(3):
            client.put(f"/api/projects/{self.project_id}", json={
                "nodes": [{"id": f"n{i}", "type": "wall", "x": 0, "y": 0, "properties": {}}],
                "edges": [], "buildingAxes": {"xValues": [], "yValues": []},
            }, headers=_auth_headers(self.token))
            client.post(f"/api/projects/{self.project_id}/history/commit",
                        params={"message": f"auto {i}", "kind": "auto"}, headers=_auth_headers(self.token))
        res = client.post(f"/api/projects/{self.project_id}/history/gc",
                           params={"keep_auto": 1}, headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["pruned_commits"], 2)

    def test_deleting_a_project_removes_its_history_directory(self):
        from auth_db import get_project_history_dir
        client.post(f"/api/projects/{self.project_id}/history/commit",
                    params={"message": "a"}, headers=_auth_headers(self.token))
        history_dir = get_project_history_dir(self.project_id)
        self.assertTrue(history_dir.exists())
        self.assertTrue((history_dir / "history.json").exists())

        res = client.delete(f"/api/projects/{self.project_id}", headers=_auth_headers(self.token))
        self.assertEqual(res.status_code, 200)
        self.assertFalse(history_dir.exists())


if __name__ == "__main__":
    unittest.main()
