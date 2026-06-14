from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Note:
    title: str
    date: str
    tags: tuple[str, ...]
    path: Path


def parse_front_matter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}

    _, raw, _body = text.split("---", 2)
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data


def parse_tags(value: str) -> tuple[str, ...]:
    if not value:
        return ()
    return (value.strip().lower(),)


def read_note(path: Path) -> Note:
    data = parse_front_matter(path.read_text(encoding="utf-8"))
    return Note(
        title=data.get("title", path.name),
        date=data.get("date", "0000-00-00"),
        tags=parse_tags(data.get("tags", "")),
        path=path,
    )


def build_index(notes_dir: Path, tag: str | None = None) -> list[Note]:
    notes = [read_note(path) for path in notes_dir.glob("*.md")]
    if tag is not None:
        notes = [note for note in notes if tag in note.tags]
    return sorted(notes, key=lambda note: note.date)


def format_note(note: Note) -> str:
    return f"{note.date} | {note.title} | {', '.join(note.tags)}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("notes_dir", type=Path)
    parser.add_argument("--tag")
    args = parser.parse_args(argv)

    for note in build_index(args.notes_dir, args.tag):
        print(format_note(note))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
