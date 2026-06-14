# ProleCoder Manual Test Projects

This directory contains small synthetic projects for manual VS Code extension and agent UX testing.

- `agent_misc_tests/` is the tracked clean baseline copy.
- `agent_misc_tests_working/` is the ignored mutable workspace opened by `.vscode/launch.json`.

The fixtures are original and intentionally not derived from SWE-bench, Terminal-Bench, or other public benchmark task datasets.

When a manual test run modifies the working copy, restore it from the clean baseline before the next full UX pass. The VS Code pre-launch task creates the working copy from `agent_misc_tests/` when it is missing. Runtime outputs such as `.prole-coder/`, `target/`, `node_modules/`, and `__pycache__/` should stay untracked.
