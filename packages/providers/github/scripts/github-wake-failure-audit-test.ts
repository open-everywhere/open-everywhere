
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-github-wake-failure-audit-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";

const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
const { liveGitHubSupervisorDeps } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { deploymentOrg } = await import("@open-everywhere/core/agent/identity/binding.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const OWNER = "acme-co";
const REPO = "widgets";
const SURFACE = `github/${OWNER}/${REPO}`;

const ev = {
  owner: OWNER,
  repo: REPO,
  issueNumber: 42,
  isPullRequest: false,
  comment: { body: "any update?", authorLogin: "alice" },
} as Parameters<typeof liveGitHubSupervisorDeps>[1];

const noopSend = (async () => ({})) as unknown as Parameters<typeof liveGitHubSupervisorDeps>[0];

{
  const boom = new Error("socket hang up");
  const failingTo = ((_channel: unknown, _target: unknown) => ({
    async send(): Promise<never> {
      throw boom;
    },
  })) as unknown as Parameters<typeof liveGitHubSupervisorDeps>[2];

  const deps = liveGitHubSupervisorDeps(noopSend, ev, failingTo);
  const before = new Date().toISOString();

  let threw: unknown;
  try {
    await deps.wake({
      token: "tok1",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
      window: { wakeId: "w1", origin: { platform: "github", owner: OWNER, repo: REPO, issueNumber: 42 } },
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "🔴 the divert failure still PROPAGATES unchanged — this is an audit ADDITION, not a swallow");

  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter((row) => row.ts >= before);
  eq(rows.length, 1, "🔴 the ambient wake's divert failure writes exactly ONE `surface.wake_failed` row — previously it wrote NONE");
  eq(rows[0]!.platform, "github", "…on the github platform");
  eq(rows[0]!.workspace, OWNER, "…keyed to the repo's owner as workspace");
  eq(rows[0]!.surface, SURFACE, "…and to the compound `github/owner/repo` surface, matching this file's OWN convention for every other audit row it writes");
  const detail = (rows[0]!.detail ?? {}) as Record<string, unknown>;
  ok(String(detail.message).includes("socket hang up"), "…and the row names the real failure");
  eq(detail.wakeId, "w1", "…and the wake id, so the row is joinable to a specific delivery attempt");
}

{
  const received: unknown[] = [];
  const okTo = ((_channel: unknown, _target: unknown) => ({
    async send(message: string, opts: unknown) {
      received.push({ message, opts });
      return {};
    },
  })) as unknown as Parameters<typeof liveGitHubSupervisorDeps>[2];

  const deps = liveGitHubSupervisorDeps(noopSend, ev, okTo);
  const before = new Date().toISOString();
  await deps.wake({
    token: "tok2",
    auth: { attributes: {} } as never,
    message: "<wake>hi again</wake>",
    context: [],
    window: { wakeId: "w2", origin: { platform: "github", owner: OWNER, repo: REPO, issueNumber: 42 } },
  });
  eq(received.length, 1, "the divert delivered normally");
  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter((row) => row.ts >= before);
  eq(rows.length, 0, "negative control: a successful divert writes NO `surface.wake_failed` row");
}

console.log(`✓ github-wake-failure-audit: ${n} assertions passed (OPE-970 ambient divert failure audit + negative control)`);
