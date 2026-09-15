import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-github-wake-failure-audit-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";

const { registerGithubProvider } = await import("../agent/register.js");
registerGithubProvider();
const { liveGitHubSupervisorDeps } = await import("../agent/channels/github.js");
const { getOperationalStore, deploymentOrg, RUN_KEY_FETCH_MARKER, HTTP_404_MARKER, PRUNED_DEPLOYMENT_AUDIT_ACTION } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);

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

  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter(
    (row) => (row.detail as { wakeId?: unknown } | undefined)?.wakeId === "w1",
  );
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
  await deps.wake({
    token: "tok2",
    auth: { attributes: {} } as never,
    message: "<wake>hi again</wake>",
    context: [],
    window: { wakeId: "w2", origin: { platform: "github", owner: OWNER, repo: REPO, issueNumber: 42 } },
  });
  eq(received.length, 1, "the divert delivered normally");
  const rows = (await getOperationalStore().readAudit({ org: deploymentOrg(), action: "surface.wake_failed" })).filter(
    (row) => (row.detail as { wakeId?: unknown } | undefined)?.wakeId === "w2",
  );
  eq(rows.length, 0, "negative control: a successful divert writes NO `surface.wake_failed` row (scoped to wakeId \"w2\", this call's own)");
}

{
  const org = deploymentOrg();
  const seedToken = "seed-tok";
  await getOperationalStore().rotateChannelSession(org, SURFACE, seedToken, "2026-08-22T00:00:00.000Z");
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(before?.rotateMarkedAt == null, "wiring precondition: the repo's seat starts UNMARKED (so a green below cannot be vacuous)");

  const boom = new Error(`${RUN_KEY_FETCH_MARKER} for wrun_TEST (deployment dpl_TEST): ${HTTP_404_MARKER} Not Found`);
  const failingSend = (async () => {
    throw boom;
  }) as unknown as Parameters<typeof liveGitHubSupervisorDeps>[0];
  const deps = liveGitHubSupervisorDeps(failingSend, ev, undefined);

  let threw: unknown;
  try {
    await deps.wake({
      token: "native-tok",
      auth: { attributes: {} } as never,
      message: "<wake>hi</wake>",
      context: [],
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "the native send failure still PROPAGATES unchanged");

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  ok(after?.rotateMarkedAt != null, "🔴 OPE-971: the NATIVE (flag-off) wake heal MARKED the repo's own seat for rotation — githubGrainFor's registryKey === surfaceKey flag-off");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "native-tok",
  );
  eq(strandRows.length, 1, "…and wrote exactly ONE strand audit row for this token");
  eq(strandRows[0]!.workspace, OWNER, "…workspace is the repo's owner, not `unknown`");
  eq((strandRows[0]!.detail as Record<string, unknown>).registryKey, SURFACE, "…the row names the registryKey it marked");
}

{
  const org = deploymentOrg();
  const before = await getOperationalStore().getChannelSession(org, SURFACE);
  const transient = new Error("socket hang up");
  const failingSend = (async () => {
    throw transient;
  }) as unknown as Parameters<typeof liveGitHubSupervisorDeps>[0];
  const deps = liveGitHubSupervisorDeps(failingSend, ev, undefined);

  await deps.wake({
    token: "transient-tok",
    auth: { attributes: {} } as never,
    message: "<wake>hi</wake>",
    context: [],
  }).catch(() => undefined);

  const after = await getOperationalStore().getChannelSession(org, SURFACE);
  eq(after?.rotateMarkedAt, before?.rotateMarkedAt, "negative control: a TRANSIENT native send failure changes NOTHING about the seat's mark state");
  const strandRows = (await getOperationalStore().readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "transient-tok",
  );
  eq(strandRows.length, 0, "…and writes no strand audit row either");
}

console.log(`✓ github-wake-failure-audit: ${n} assertions passed (OPE-970 ambient divert failure audit + negative control, OPE-971 native flag-off heal + negative control)`);
