const MAX_DEPTH = 4;
const MAX_CHARS = 4_000;

function render(err: unknown, depth: number): string {
  if (!(err instanceof Error)) return String(err);
  let out = err.message.length > 0 ? err.message : err.name;
  if (depth >= MAX_DEPTH) return out;
  if (err instanceof AggregateError && err.errors.length > 0) {
    out += ": " + err.errors.map((inner, i) => `[${i + 1}] ${render(inner, depth + 1)}`).join("; ");
  }
  if (err.cause !== undefined) out += ` (cause: ${render(err.cause, depth + 1)})`;
  return out;
}

export function scenarioFailureMessage(err: unknown): string {
  const text = render(err, 0);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}… (${text.length - MAX_CHARS} more chars)` : text;
}
