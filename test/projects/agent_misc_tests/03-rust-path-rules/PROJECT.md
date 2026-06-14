# Path Rules Lab

Path Rules Lab is a tiny synthetic Rust crate for manual agent testing. It asks the agent to implement workspace-relative path normalization with clear safety boundaries.

This project is intentionally original and does not copy tasks, files, tests, or prompts from SWE-bench, Terminal-Bench, or similar benchmark datasets.

What this tests:

- Rust editing and test execution.
- Security-minded path normalization.
- Handling Windows and Unix path edge cases.
- Keeping implementation small and deterministic.
