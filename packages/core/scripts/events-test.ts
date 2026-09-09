import { createHmac } from "node:crypto";
import { normalizeGithubEvent, eventPrompt, verifyGithubSignature, gateGithubDelivery } from "../agent/routines/events.js";
import { liftGithubEvent, githubEventNormalizer } from "../agent/routines/github-normalizer.js";
import { evaluateSubscription, validateSubscription } from "../agent/routines/event-match.js";
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

const runPayload = {
  action: "completed",
  workflow: { name: "CI" },
  workflow_run: {
    id: 987654321,
    name: "CI",
    head_branch: "main",
    head_sha: "cafebabe",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/me/proj/actions/runs/987654321",
  },
  repository: { full_name: "me/proj", name: "proj", html_url: "https://github.com/me/proj" },
  sender: { login: "github-actions[bot]" },
};
const runV1 = normalizeGithubEvent("workflow_run", runPayload);
ok(runV1 !== null && runV1.event === "workflow_run" && runV1.action === "completed", "workflow_run: normalizes with its action");
ok(runV1!.title === "CI", "workflow_run: the title is the workflow's name, read off the run object");
ok(runV1!.url === "https://github.com/me/proj/actions/runs/987654321", "workflow_run: the url is the RUN's, never the repository's");
ok(runV1!.number === undefined, "workflow_run: no issue-style number — GitHub numbers a run with `run_number`, not `number`");

const runV2 = liftGithubEvent("workflow_run", runPayload);
ok(runV2 !== null, "workflow_run: lifts onto the v2 model");
ok(runV2!.fields["branch"] === "main", "workflow_run: `branch` is filterable — the half of `a red build on main` that says WHERE");
ok(runV2!.fields["conclusion"] === "failure", "workflow_run: `conclusion` is filterable — the half that says RED");
ok(runV2!.fields["status"] === "completed", "workflow_run: `status` carries the lifecycle, distinct from the verdict");
ok(runV2!.fields["workflow"] === "CI", "workflow_run: `workflow` names which build, so one repo's many workflows are separable");
for (const key of ["branch", "status", "conclusion", "workflow"]) {
  ok(githubEventNormalizer.matchKeys.includes(key), `workflow_run: \`${key}\` is a DECLARED match key, so a filter may name it`);
}
ok(
  runV2!.scope.some((s) => s.kind === "entity" && s.id === "987654321"),
  "workflow_run: the entity scope step is the run id, so a subscription can narrow to one run",
);
const DOCUMENTED_RUN_FILTER = '.scope.container == "acme/web" and .fields.conclusion == "failure" and .fields.branch == "main"';
let armed = true;
try {
  validateSubscription("github", DOCUMENTED_RUN_FILTER);
} catch {
  armed = false;
}
ok(armed, "workflow_run: the filter the docs print is ACCEPTED by validateSubscription — it can actually be armed");
let refused = false;
try {
  validateSubscription("github", '.fields.conclusion == "failure" and .fields.branch == "main"');
} catch {
  refused = true;
}
ok(refused, "workflow_run: the same filter WITHOUT a container clause is REFUSED — the scope clause is load-bearing, not decoration");
ok(runV2!.pointer === undefined, "workflow_run: NO fetch pointer — a run id is not an issue number, and the read adapter's endpoint only understands one");
const releaseV2 = liftGithubEvent("release", {
  action: "published",
  release: { id: 55, name: "v1.2.0", html_url: "https://github.com/me/proj/releases/tag/v1.2.0" },
  repository: { full_name: "me/proj", html_url: "https://github.com/me/proj" },
});
ok(releaseV2!.scope.some((s) => s.kind === "entity" && s.id === "55"), "release: the opaque id still narrows the scope path");
ok(releaseV2!.pointer === undefined, "release: an opaque vendor id gets no pointer either — same rule, not a workflow_run special case");
ok(liftGithubEvent("pull_request", prPayload)!.pointer?.id === "me/proj#42", "pull_request: an issue-style number STILL yields a fetch pointer");
const pushV2 = liftGithubEvent("push", { ref: "refs/heads/main", repository: { full_name: "me/proj" } });
ok(
  pushV2!.fields["branch"] === undefined && pushV2!.fields["conclusion"] === undefined,
  "the workflow_run keys are absent on every other event — a `conclusion` filter never matches a push",
);

console.log(`✓ events: ${passed} assertions passed`);
