import { createHmac, timingSafeEqual } from "node:crypto";
import { ingestUntrusted } from "../access/untrusted.js";
import { renderFailureBlock, renderReachBlock } from "./watch.js";
import { renderPolicyBlock } from "./policy.js";
import { renderCollectedBlock, type CollectedInput } from "./collector.js";
import { renderFollowUpsBlock } from "./follow-ups.js";
import { isJobRoutine, type Routine } from "./routine.js";

export interface LegacyGithubEvent {
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

export function normalizeGithubEvent(eventType: string, payload: Record<string, unknown>): LegacyGithubEvent | null {
  if (!eventType || eventType === "ping") return null;
  const action = str(payload["action"]);
  const repo = str(obj(payload["repository"])?.["full_name"]);
  const sender = str(obj(payload["sender"])?.["login"]);

  const subject =
    obj(payload["pull_request"]) ??
    obj(payload["issue"]) ??
    obj(payload["check_run"]) ??
    obj(payload["release"]) ??
    obj(payload["workflow_run"]);
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

export function eventPrompt(
  routine: Pick<Routine, "prompt"> & Partial<Pick<Routine, "policy" | "followUps" | "sessionMode">>,
  ev: { readonly summary: string; readonly url?: string; readonly entity?: string },
  collected: readonly CollectedInput[] = [],
): string {
  const body = [ev.summary, ev.url, ev.entity].filter((s): s is string => Boolean(s)).join("\n");
  const rules = renderPolicyBlock(routine);
  const followUps = renderFollowUpsBlock(routine);
  const head = [
    renderFailureBlock(),
    renderReachBlock(isJobRoutine(routine) ? "job-restricted" : "full"),
    ...(rules.length > 0 ? [rules] : []),
    ...(followUps.length > 0 ? [followUps] : []),
  ].join("\n\n");
  const collectedBlock = renderCollectedBlock(collected);
  const fenced = ingestUntrusted(body, { source: "github event", ingestion: { kind: "routine-event", label: "github-event" } });
  return `${head}\n\n${routine.prompt}\n\n${fenced}${collectedBlock.length > 0 ? `\n\n${collectedBlock}` : ""}`;
}

export function verifyGithubSignature(secret: string, body: string, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function gateGithubDelivery(
  secret: string | undefined,
  body: string,
  signatureHeader: string | null,
  allowUnverified: boolean,
): string | null {
  if (!secret) {
    return allowUnverified
      ? null
      : "GITHUB_WEBHOOK_SECRET is not set — rejecting unverified delivery (set the secret, or turn on webhooks.allowUnverifiedGithub in agent/settings/settings.ts for local dev)";
  }
  return verifyGithubSignature(secret, body, signatureHeader) ? null : "invalid signature";
}
