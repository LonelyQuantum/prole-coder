# Task: Fix event timeline reducer

## Goal

Fix `src/timelineReducer.js` so the reducer keeps a compact and accurate UI timeline.

## Requirements

- Merge consecutive `assistant.delta` events that share the same `runId` and `turnId`.
- Keep separate assistant messages for different turns.
- Add approval items when `approval.requested` arrives.
- Mark approval items as resolved when `approval.completed` arrives.
- When a run reaches `run.completed`, `run.failed`, or `run.canceled`, set `activeRunId` to `undefined`.
- Preserve unknown events as compact system items.

## Validation

Run from this directory:

```powershell
npm test
```
