# Task: Implement workspace path normalization

## Goal

Fix `src/lib.rs` so workspace-relative path normalization is predictable and safe.

## Requirements

- Accept relative file paths and normalize `\` to `/`.
- Collapse `.` and repeated separators.
- Resolve safe `..` segments that stay inside the workspace.
- Reject paths that escape above the workspace.
- Reject absolute Unix paths, Windows drive paths, UNC paths, empty paths, and paths with NUL bytes.
- Return normalized paths without leading `./`.

## Validation

Run from this directory:

```powershell
cargo test
```
