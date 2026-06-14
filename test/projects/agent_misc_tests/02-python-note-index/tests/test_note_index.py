from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from src.note_index import build_index, parse_tags


class NoteIndexTests(unittest.TestCase):
    def make_notes(self, root: Path) -> Path:
        notes = root / "notes"
        notes.mkdir()
        (notes / "api-design.md").write_text(
            "---\n"
            "title: API Design\n"
            "date: 2026-01-10\n"
            "tags: [Architecture, RPC]\n"
            "---\n"
            "Details\n",
            encoding="utf-8",
        )
        (notes / "release-plan.md").write_text(
            "---\n"
            "title: Release Plan\n"
            "date: 2026-02-05\n"
            "tags: planning, rpc\n"
            "---\n"
            "Details\n",
            encoding="utf-8",
        )
        (notes / "untitled-note.md").write_text(
            "---\n"
            "date: 2026-01-20\n"
            "tags: misc\n"
            "---\n"
            "Details\n",
            encoding="utf-8",
        )
        return notes

    def test_parse_tags_accepts_bracket_and_csv_forms(self) -> None:
        self.assertEqual(parse_tags("[Architecture, RPC]"), ("architecture", "rpc"))
        self.assertEqual(parse_tags("planning, rpc"), ("planning", "rpc"))

    def test_build_index_filters_case_insensitively_and_sorts_descending(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            notes = self.make_notes(Path(temp))
            result = build_index(notes, tag="RPC")

        self.assertEqual([note.title for note in result], ["Release Plan", "API Design"])

    def test_missing_title_uses_file_stem(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            notes = self.make_notes(Path(temp))
            result = build_index(notes, tag="misc")

        self.assertEqual(result[0].title, "untitled-note")

    def test_cli_prints_stable_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            notes = self.make_notes(Path(temp))
            completed = subprocess.run(
                [sys.executable, "-m", "src.note_index", str(notes), "--tag", "rpc"],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertEqual(
            completed.stdout.splitlines(),
            [
                "2026-02-05 | Release Plan | planning, rpc",
                "2026-01-10 | API Design | architecture, rpc",
            ],
        )


if __name__ == "__main__":
    unittest.main()
