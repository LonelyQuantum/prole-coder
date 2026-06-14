export function createInitialState() {
  return {
    activeRunId: undefined,
    items: []
  };
}

export function reduceEvent(state, event) {
  const next = {
    activeRunId: state.activeRunId,
    items: [...state.items]
  };

  if (event.type === "turn.started") {
    next.activeRunId = event.runId;
    next.items.push({ kind: "turn", runId: event.runId, turnId: event.turnId, text: event.payload?.message ?? "" });
    return next;
  }

  if (event.type === "assistant.delta") {
    next.items.push({ kind: "assistant", runId: event.runId, turnId: event.turnId, text: event.payload?.text ?? "" });
    return next;
  }

  if (event.type === "approval.requested") {
    next.items.push({ kind: "approval", id: event.payload?.approvalId, status: "pending" });
    return next;
  }

  if (event.type === "run.completed") {
    next.items.push({ kind: "terminal", status: "completed", runId: event.runId });
    return next;
  }

  next.items.push({ kind: "system", text: event.type });
  return next;
}

export function reduceEvents(events) {
  return events.reduce(reduceEvent, createInitialState());
}
