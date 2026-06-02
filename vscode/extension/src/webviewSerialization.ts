export function safeScriptJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? "undefined" : serialized).replaceAll("<", "\\u003c");
}
