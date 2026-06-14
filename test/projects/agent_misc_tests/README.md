# Agent Misc Tests

This workspace contains small synthetic tasks for manual ProleCoder testing.

The fixtures are original and intentionally not derived from SWE-bench, Terminal-Bench, or other public benchmark task datasets. They are meant for smoke testing agent behavior, approval UX, file editing, test running, and multi-turn context handling.

Recommended flow:

1. Open this directory in the Extension Development Host.
2. Pick one subdirectory.
3. Ask `@prole` to read that subdirectory's `AGENT_TASK.md` and complete the task.
4. Approve commands and edits only when they match the task.
5. Run the listed validation command.

Suggested order:

1. `01-js-ledger-lite` - JavaScript bug fix with Node built-in tests.
2. `02-python-note-index` - Python parser and CLI behavior fix with unittest.
3. `03-rust-path-rules` - Rust path normalization and safety checks.
4. `04-js-event-reducer` - JavaScript event timeline reducer behavior.
