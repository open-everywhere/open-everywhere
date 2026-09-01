import { createHmac } from "node:crypto";
import { normalizeGithubEvent, eventPrompt, verifyGithubSignature, gateGithubDelivery } from "../agent/routines/events.js";
import { liftGithubEvent } from "../agent/routines/github-normalizer.js";
import { evaluateSubscription } from "../agent/routines/event-match.js";
import type { Routine } from "../agent/routines/routine.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function eventRoutine(jq?: string): Routine {
  return {
    id: "r-ev",
    org: "default",
    surfaceKey: "slack/T1/C9",
    target: { channelId: "C9" },
    trigger: { kind: "event", source: "github", jq },
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

const prV2 = liftGithubEvent("pull_request", prPayload)!;
const matches = async (r: Routine): Promise<boolean> => {
  const v = await evaluateSubscription(r, prV2);
  return !("invalid" in v) && v.match;
};
ok(await matches(eventRoutine()), "no filter -> matches any github event");
ok(await matches(eventRoutine('(.fields["event"] | IN("pull_request")) and (.fields["action"] | IN("opened"))')), "filter event+action matches");
ok(!(await matches(eventRoutine('(.fields["action"] | IN("closed"))'))), "filter action mismatch -> no match");
ok(await matches(eventRoutine('(.fields["repo"] | IN("me/proj"))')), "filter repo matches");
ok(!(await matches(eventRoutine('(.fields["repo"] | IN("other/repo"))'))), "filter repo mismatch -> no match");
const wrongSource: Routine = { ...eventRoutine(), trigger: { kind: "event", source: "gitlab" } };
ok(!(await matches(wrongSource)), "different source -> no match");
const clockRoutine: Routine = { ...eventRoutine(), trigger: { kind: "interval", everyMinutes: 5 } };
ok(!(await matches(clockRoutine)), "non-event routine never matches an event");

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
ok(gateGithubDelivery(undefined, body, null, true) === null, "unset secret + the webhooks.allowUnverifiedGithub escape hatch -> accepted");
ok(gateGithubDelivery(secret, body, "sha256=deadbeef", true) !== null, "escape hatch does NOT bypass verification when a secret IS set");

console.log(`✓ events: ${passed} assertions passed`);
