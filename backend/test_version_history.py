"""
test_version_history.py — unit tests for version_history.py.

Uses only the standard-library `unittest` (no pytest dependency in this
backend). Run with:  backend/.venv/bin/python -m unittest test_version_history -v
"""

import json
import tempfile
import unittest
from pathlib import Path

from version_history import VersionHistory


class VersionHistoryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vh = VersionHistory(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def test_first_commit(self):
        entry = self.vh.commit({"nodes": [{"id": "n1"}], "edges": []}, "initial", "manual")
        self.assertEqual(entry["id"], 1)
        self.assertIsNone(entry["parent"])
        self.assertEqual(entry["node_count"], 1)
        self.assertEqual(entry["edge_count"], 0)

    def test_commits_chain_by_parent_id(self):
        c1 = self.vh.commit({"nodes": [], "edges": []}, "a", "manual")
        c2 = self.vh.commit({"nodes": [{"id": "n1"}], "edges": []}, "b", "manual")
        self.assertEqual(c2["parent"], c1["id"])
        self.assertEqual(c2["id"], c1["id"] + 1)

    def test_identical_content_dedups_to_one_blob(self):
        data = {"nodes": [{"id": "n1"}], "edges": []}
        self.vh.commit(data, "a", "manual")
        self.vh.commit(dict(data), "b", "manual")  # separate dict, same content
        blobs = list(self.vh.objects_path.glob("*/*.json"))
        self.assertEqual(len(blobs), 1)

    def test_identical_content_is_a_commit_no_op(self):
        data = {"nodes": [], "edges": []}
        c1 = self.vh.commit(data, "a", "auto")
        c2 = self.vh.commit(data, "b (same content)", "auto")
        self.assertEqual(c1["id"], c2["id"])  # HEAD unchanged, no new commit
        self.assertEqual(len(self.vh.list_commits()), 1)

    def test_checkpoint_is_never_a_no_op_even_with_unchanged_content(self):
        data = {"nodes": [], "edges": []}
        self.vh.commit(data, "auto save", "auto")
        cp = self.vh.commit(data, "milestone", "checkpoint")
        self.assertEqual(len(self.vh.list_commits()), 2)
        self.assertEqual(cp["kind"], "checkpoint")

    def test_list_commits_is_newest_first_and_respects_limit(self):
        for i in range(5):
            self.vh.commit({"nodes": [{"id": str(i)}], "edges": []}, str(i), "manual")
        listed = self.vh.list_commits()
        self.assertEqual([e["id"] for e in listed], [5, 4, 3, 2, 1])
        self.assertEqual(len(self.vh.list_commits(limit=2)), 2)

    def test_get_content_round_trips(self):
        data = {"nodes": [{"id": "n1", "type": "wall"}], "edges": [{"id": "e1"}]}
        entry = self.vh.commit(data, "a", "manual")
        self.assertEqual(self.vh.get_content(entry["id"]), data)
        self.assertIsNone(self.vh.get_content(9999))

    def test_new_commits_start_with_an_empty_comments_list(self):
        entry = self.vh.commit({"nodes": [], "edges": []}, "a", "manual")
        self.assertEqual(entry["comments"], [])

    def test_add_comment_appends_without_touching_content_or_message(self):
        entry = self.vh.commit({"nodes": [{"id": "n1"}], "edges": []}, "Auto-save", "auto")
        original_hash = entry["hash"]

        updated = self.vh.add_comment(entry["id"], "switched to concrete slabs here")
        self.assertEqual(len(updated["comments"]), 1)
        self.assertEqual(updated["comments"][0]["text"], "switched to concrete slabs here")
        self.assertIn("timestamp", updated["comments"][0])
        self.assertEqual(updated["message"], "Auto-save")  # untouched
        self.assertEqual(updated["hash"], original_hash)   # untouched — no new blob/commit

        # Comments accumulate — a second comment doesn't replace the first.
        updated2 = self.vh.add_comment(entry["id"], "actually reverted this later")
        self.assertEqual(len(updated2["comments"]), 2)
        self.assertEqual(self.vh.get_commit(entry["id"])["comments"], updated2["comments"])

    def test_add_comment_persists_across_a_fresh_load(self):
        entry = self.vh.commit({"nodes": [], "edges": []}, "a", "manual")
        self.vh.add_comment(entry["id"], "note")
        # A brand new VersionHistory instance pointed at the same root re-reads history.json from disk.
        reloaded = VersionHistory(self.vh.objects_path.parent)
        self.assertEqual(reloaded.get_commit(entry["id"])["comments"][0]["text"], "note")

    def test_add_comment_on_unknown_commit_returns_none(self):
        self.assertIsNone(self.vh.add_comment(9999, "note"))

    def test_add_comment_ignores_blank_text(self):
        entry = self.vh.commit({"nodes": [], "edges": []}, "a", "manual")
        result = self.vh.add_comment(entry["id"], "   ")
        self.assertEqual(result["comments"], [])

    def test_restore_appends_a_new_commit_and_never_rewrites_history(self):
        c1 = self.vh.commit({"nodes": [{"id": "n1"}], "edges": []}, "first", "manual")
        self.vh.commit({"nodes": [{"id": "n1"}, {"id": "n2"}], "edges": []}, "second", "manual")

        result = self.vh.restore(c1["id"])
        self.assertIsNotNone(result)
        self.assertEqual(result["content"], {"nodes": [{"id": "n1"}], "edges": []})
        self.assertEqual(result["commit"]["kind"], "restore")
        self.assertEqual(result["commit"]["id"], 3)  # appended, not overwriting #1 or #2

        all_commits = self.vh.list_commits()
        self.assertEqual(len(all_commits), 3)  # nothing was deleted
        self.assertEqual(self.vh.get_content(1), {"nodes": [{"id": "n1"}], "edges": []})
        self.assertEqual(self.vh.get_content(2)["nodes"], [{"id": "n1"}, {"id": "n2"}])

    def test_restore_of_unknown_commit_returns_none(self):
        self.assertIsNone(self.vh.restore(999))

    def test_prune_auto_commits_keeps_durable_kinds_and_recent_autos(self):
        for i in range(10):
            self.vh.commit({"nodes": [{"id": str(i)}], "edges": []}, f"auto {i}", "auto")
        self.vh.commit({"nodes": [{"id": "cp"}], "edges": []}, "milestone", "checkpoint")

        dropped = self.vh.prune_auto_commits(keep=3)
        self.assertEqual(dropped, 7)  # 10 autos - keep 3

        remaining_kinds = [e["kind"] for e in self.vh.list_commits()]
        self.assertEqual(remaining_kinds.count("auto"), 3)
        self.assertEqual(remaining_kinds.count("checkpoint"), 1)  # never pruned

    def test_gc_removes_only_unreferenced_blobs(self):
        c1 = self.vh.commit({"nodes": [{"id": "a"}], "edges": []}, "a", "auto")
        self.vh.commit({"nodes": [{"id": "b"}], "edges": []}, "b", "auto")
        self.assertEqual(len(list(self.vh.objects_path.glob("*/*.json"))), 2)

        # Drop commit #1's metadata (simulate prune), then gc() should free its blob.
        log = self.vh._load_log()
        self.vh._save_log([e for e in log if e["id"] != c1["id"]])

        result = self.vh.gc()
        self.assertEqual(result["freed_count"], 1)
        self.assertEqual(len(list(self.vh.objects_path.glob("*/*.json"))), 1)

    def test_diff_summary_reports_added_removed_modified(self):
        c1 = self.vh.commit({
            "nodes": [{"id": "n1", "x": 0}, {"id": "n2", "x": 0}],
            "edges": [{"id": "e1", "from": "n1", "to": "n2"}],
        }, "a", "manual")
        c2 = self.vh.commit({
            "nodes": [{"id": "n1", "x": 100}, {"id": "n3", "x": 0}],  # n1 modified, n2 removed, n3 added
            "edges": [],  # e1 removed
        }, "b", "manual")

        diff = self.vh.diff_summary(c1["id"], c2["id"])
        self.assertEqual(diff["nodes"]["added"], ["n3"])
        self.assertEqual(diff["nodes"]["removed"], ["n2"])
        self.assertEqual(diff["nodes"]["modified"], ["n1"])
        self.assertEqual(diff["edges"]["removed"], ["e1"])

    def test_diff_summary_returns_none_for_unknown_commit(self):
        c1 = self.vh.commit({"nodes": [], "edges": []}, "a", "manual")
        self.assertIsNone(self.vh.diff_summary(c1["id"], 9999))

    def test_history_json_is_small_metadata_only_not_full_graph_content(self):
        big_data = {"nodes": [{"id": str(i), "blob": "x" * 1000} for i in range(50)], "edges": []}
        self.vh.commit(big_data, "big", "manual")
        history_size = self.vh.history_path.stat().st_size
        blob_size = next(self.vh.objects_path.glob("*/*.json")).stat().st_size
        self.assertLess(history_size, blob_size / 4)


if __name__ == "__main__":
    unittest.main()
