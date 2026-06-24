import { createHmac, timingSafeEqual } from "node:crypto";
import type { Routine } from "./routine.js";

export interface NormalizedEvent {
  readonly source: string;
  readonly event: string;
  readonly action?: string;
  readonly repo?: string;
  readonly number?: number;
  readonly title?: string;
  readonly url?: string;
  readonly sender?: string;
  readonly summary: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

export function normalizeGithubEvent(eventType: string, payload: Record<string, unknown>): NormalizedEvent | null {
  if (!eventType || eventType === "ping") return null;
  const action = str(payload["action"]);
  const repo = str(obj(payload["repository"])?.["full_name"]);
  const sender = str(obj(payload["sender"])?.["login"]);

  const subject =
    obj(payload["pull_request"]) ?? obj(payload["issue"]) ?? obj(payload["check_run"]) ?? obj(payload["release"]);
  const number = typeof subject?.["number"] === "number" ? (subject["number"] as number) : undefined;
  const title = str(subject?.["title"]) ?? str(subject?.["name"]);
  const url = str(subject?.["html_url"]) ?? str(obj(payload["repository"])?.["html_url"]);

  const head = [eventType, action].filter(Boolean).join(" ");
  const where = repo ? ` on ${repo}` : "";
  const what = number ? ` #${number}` : "";
  const named = title ? `: ${title}` : "";
  const who = sender ? ` (by ${sender})` : "";
  const summary = `${head}${what}${where}${named}${who}`;

  return { source: "github", event: eventType, action, repo, number, title, url, sender, summary };
}

const MATCH_FIELDS: Record<string, (e: NormalizedEvent) => string | undefined> = {
  event: (e) => e.event,
  action: (e) => e.action,
  repo: (e) => e.repo,
  sender: (e) => e.sender,
};

export function matchesEvent(routine: Routine, ev: NormalizedEvent): boolean {
  const t = routine.trigger;
  if (t.kind !== "event") return false;
  if (t.source !== ev.source) return false;
  if (!t.match) return true;
  for (const [key, want] of Object.entries(t.match)) {
    const actual = MATCH_FIELDS[key]?.(ev);
    if (actual !== want) return false;
  }
  return true;
}

export function eventPrompt(routine: Routine, ev: NormalizedEvent): string {
  const lines = [`<github_event>`, ev.summary];
  if (ev.url) lines.push(ev.url);
  lines.push(`</github_event>`);
  return `${routine.prompt}\n\n${lines.join("\n")}`;
}

export function verifyGithubSignature(secret: string, body: string, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
