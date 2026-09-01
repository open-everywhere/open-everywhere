import { LinearApiError } from "eve/channels/linear";
import { RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";

export function describeLinearError(err: unknown): string {
  if (err instanceof RateLimitExhaustedError) {
    return `HTTP ${err.status} rate limited — ${err.operation} gave up after ${err.attempts} attempts (waited ${err.waitedMs} ms)`;
  }
  if (err instanceof LinearApiError) {
    const body = err.body as { errors?: Array<{ message?: unknown }> } | undefined;
    const msgs = Array.isArray(body?.errors)
      ? body.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("; ")
      : "";
    return `HTTP ${err.status}${msgs ? `: ${msgs}` : ""}`.slice(0, 240);
  }
  return "network/transport error";
}
