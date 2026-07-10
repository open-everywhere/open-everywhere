import { createHmac } from "node:crypto";
import {
  normalizeGithubEvent,
  matchesEvent,
  eventPrompt,
  verifyGithubSignature,
  gateGithubDelivery,
} from "../agent/routines/events.js";
import type { Routine } from "../agent/routines/routine.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function eventRoutine(match?: Record<string, string>): Routine {
  return {
    id: "r-ev",
    org: "default",
    surfaceKey: "slack/T1/C9",
    target: { channelId: "C9" },
    trigger: { kind: "event", source: "github", match },
    prompt: "Summarise the PR and flag risky files.",
    createdAt: "2026-06-24T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };
}

const prPayload = {
  action: "opened",
  pull_request: { number: 42, title: "Add caching", html_url: "https://github.com/me/proj/pull/42" },
  repository: { full_name: "me/proj", html_url: "https://github.com/me/proj" },
  sender: { login: "alice" },
};
const pr = normalizeGithubEvent("pull_request", prPayload);
ok(pr !== null, "pull_request normalizes");
ok(pr!.event === "pull_request" && pr!.action === "opened", "normalize: event + action");
ok(pr!.repo === "me/proj" && pr!.number === 42 && pr!.sender === "alice", "normalize: repo/number/sender");
ok(pr!.url === "https://github.com/me/proj/pull/42", "normalize: subject html_url preferred");
ok(pr!.summary.includes("#42") && pr!.summary.includes("me/proj") && pr!.summary.includes("alice"), "normalize: summary is descriptive");
ok(normalizeGithubEvent("ping", {}) === null, "ping is ignored (null)");
ok(normalizeGithubEvent("", {}) === null, "empty event type is ignored");
const issue = normalizeGithubEvent("issues", { action: "labeled", issue: { number: 7, title: "Bug" }, repository: { full_name: "me/proj" } });
ok(issue!.number === 7 && issue!.action === "labeled", "normalize: issues event");

ok(matchesEvent(eventRoutine(), pr!), "no filter -> matches any github event");
ok(matchesEvent(eventRoutine({ event: "pull_request", action: "opened" }), pr!), "filter event+action matches");
ok(!matchesEvent(eventRoutine({ action: "closed" }), pr!), "filter action mismatch -> no match");
ok(matchesEvent(eventRoutine({ repo: "me/proj" }), pr!), "filter repo matches");
ok(!matchesEvent(eventRoutine({ repo: "other/repo" }), pr!), "filter repo mismatch -> no match");
const wrongSource: Routine = { ...eventRoutine(), trigger: { kind: "event", source: "gitlab" } };
ok(!matchesEvent(wrongSource, pr!), "different source -> no match");
const clockRoutine: Routine = { ...eventRoutine(), trigger: { kind: "interval", everyMinutes: 5 } };
ok(!matchesEvent(clockRoutine, pr!), "non-event routine never matches an event");

const prompt = eventPrompt(eventRoutine(), pr!);
ok(
  prompt.includes("Summarise the PR") && prompt.includes("<untrusted_external_data") && prompt.includes("pull/42"),
  "eventPrompt embeds instruction + FENCES the attacker-controlled event body as untrusted data (P0-3)",
);

const secret = "s3cr3t";
const body = JSON.stringify(prPayload);
const good = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
ok(verifyGithubSignature(secret, body, good), "valid signature verifies");
ok(!verifyGithubSignature(secret, body, "sha256=deadbeef"), "tampered signature rejected");
ok(!verifyGithubSignature(secret, body, null), "missing signature rejected");
ok(!verifyGithubSignature("wrong", body, good), "wrong secret rejected");

ok(gateGithubDelivery(secret, body, good, false) === null, "configured secret + valid signature -> accepted");
ok(gateGithubDelivery(secret, body, "sha256=deadbeef", false) !== null, "configured secret + bad signature -> rejected");
const noSecret = gateGithubDelivery(undefined, body, good, false);
ok(noSecret !== null && noSecret.includes("GITHUB_WEBHOOK_SECRET"), "unset secret -> rejected with a clear reason (fail-closed, NOT accept-all)");
ok(gateGithubDelivery("", body, good, false) !== null, "empty-string secret is treated as unset -> rejected");
ok(gateGithubDelivery(undefined, body, null, true) === null, "unset secret + OE_ALLOW_UNVERIFIED_GITHUB_WEBHOOK escape hatch -> accepted");
ok(gateGithubDelivery(secret, body, "sha256=deadbeef", true) !== null, "escape hatch does NOT bypass verification when a secret IS set");

console.log(`✓ events: ${passed} assertions passed`);
