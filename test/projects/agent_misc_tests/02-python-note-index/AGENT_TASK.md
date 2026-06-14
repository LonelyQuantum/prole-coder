# Task: Fix note index parsing and CLI output

## Goal

Fix `src/note_index.py` so the note index builder and CLI pass the tests without adding third-party dependencies.

## Requirements

- Parse the simple YAML-like front matter at the top of each note.
- Support `tags: [A, B]` and `tags: A, B` forms.
- Tag filtering should be case-insensitive.
- Notes should be sorted by date descending, then title ascending.
- Missing titles should fall back to the file stem.
- The CLI should print one line per note as `YYYY-MM-DD | Title | tag1, tag2`.

## Validation

Run from this directory:

```powershell
python -m unittest discover -s tests
```
