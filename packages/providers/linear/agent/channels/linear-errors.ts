import { LinearApiError } from "eve/channels/linear";

export function describeLinearError(err: unknown): string {
  if (err instanceof LinearApiError) {
    const body = err.body as { errors?: Array<{ message?: unknown }> } | undefined;
    const msgs = Array.isArray(body?.errors)
      ? body.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("; ")
      : "";
    return `HTTP ${err.status}${msgs ? `: ${msgs}` : ""}`.slice(0, 240);
  }
  return "network/transport error";
}
