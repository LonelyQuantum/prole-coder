# Synthetic Agent Task Prompts

Use one prompt at a time in the VS Code Chat sidebar.

## Task 1: JS ledger bug fix

```text
@prole /edit In 01-js-ledger-lite, read AGENT_TASK.md and fix the ledger behavior. Keep the public API stable and run the listed tests.
```

## Task 2: Python note index

```text
@prole /edit In 02-python-note-index, read AGENT_TASK.md and make the note index parser and CLI pass the tests. Avoid adding third-party dependencies.
```

## Task 3: Rust workspace path rules

```text
@prole /edit In 03-rust-path-rules, read AGENT_TASK.md and implement robust workspace-relative path normalization. Run cargo test for that crate.
```

## Task 4: JS event reducer

```text
@prole /edit In 04-js-event-reducer, read AGENT_TASK.md and fix the event reducer so the timeline state tests pass.
```

## Multi-turn follow-up checks

```text
@prole /review Review the changes you just made in the current subdirectory and point out one possible edge case not covered by tests.
```

```text
@prole /ask Summarize what files changed and which validation command passed.
```
