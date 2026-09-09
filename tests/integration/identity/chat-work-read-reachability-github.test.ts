import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  armSettlement,
  bootAgent,
  consumeSettlement,
  disposeLater,
  GITHUB_BOT_SLUG,
  githubIssueCommentPost,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

process.env.GITHUB_APP_SLUG = GITHUB_BOT_SLUG;

for (const k of [
  "GITHUB_TOKEN",
  "OE_GITHUB_APP_ID",
  "OE_GITHUB_APP_PRIVATE_KEY",
  "OE_GITHUB_APP_SLUG",
  "OE_GITHUB_INSTALLATIONS",
  "OE_GITHUB_OWNER",
  "OE_GITHUB_INSTALLATION_ID",
]) {
  delete process.env[k];
}

const OWNER = "example-owner";
const REPO = "e2e-scratch";
const SURFACE_KEY = `github/${OWNER}/${REPO}`;

async function pinShippedFixture(): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const home = loadDomains().find((d) => (d.reach ?? []).includes(SURFACE_KEY));
  expect(home, `${SURFACE_KEY} is in no domain — a wake there reaches no window seat`).toBeDefined();
  expect(home?.mode, `${home?.name} is not a window domain, so the ambient wake reaches no delegating seat`).toBe("unified");
  expect(home?.ambientSupervisor, `${home?.name} does not run an ambient supervisor — the GitHub ambient leg stands down`).toBe(true);

  const { surfaces } = await import("../../../agent/identity/surfaces");
  expect(
    surfaces.some((s) => (s.key === SURFACE_KEY || s.key === `github/${OWNER}`) && s.trust === "internal"),
    `neither ${SURFACE_KEY} nor github/${OWNER} is vouched internal — the window-admission floor refuses the wake`,
  ).toBe(true);

  const { loadBundles, loadBindings } = await import("../../../agent/access/bundles");
  const repoBundle = loadBundles().find((b) => (b.repos ?? []).includes(`${OWNER}/${REPO}`));
  expect(repoBundle, `no access bundle grants the repo ${OWNER}/${REPO} — the GitHub work grant resolves an empty repo list`).toBeDefined();
  expect(
    loadBindings().some((b) => b.bundle === repoBundle?.name && b.scope.level === "domain" && b.scope.domain === home?.name),
    `"${repoBundle?.name}" is not bound at DOMAIN scope on "${home?.name}" — a GitHub-woken session resolves no repo grant (OPE-1004)`,
  ).toBe(true);

  expect(process.env.GITHUB_TOKEN, "an ambient GITHUB_TOKEN survived the scrub — this file would talk to GitHub for real").toBeUndefined();
  const { loadGitHubAppConfig } = await import("@open-everywhere/core/agent/scm/config.js");
  expect(loadGitHubAppConfig(), "a GitHub App config survived the scrub — the work read would mint an installation token over the network").toBeNull();

  const { domainHoldsSurfaceWorkGrant } = await import("@open-everywhere/core/agent/access/surface-work-grant.js");
  expect(
    domainHoldsSurfaceWorkGrant(home, "github", [`${OWNER}/${REPO}`]),
    "the GitHub work-grant gate refuses the granted repo — the mount below could never fire",
  ).toBe(true);
  expect(
    domainHoldsSurfaceWorkGrant(home, "github", []),
    "🔴 the GitHub work-grant gate answered TRUE with no repo grant at all — the arm below would pass vacuously",
  ).toBe(false);
}

function assertWorkerHoldsWorkReads(handle: ScriptedHandle): void {
  const worker = handle.requests.find((r) => r.role === "child");
  expect(worker, "no worker request was recorded — the delegation never reached a child").toBeDefined();
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(
      worker!.tools,
      `🔴 github: the worker was NOT offered ${verb} — the granted work read never mounted on a real GitHub wake. It was offered [${worker!.tools.slice().sort().join(", ")}]`,
    ).toContain(verb);
  }
  const seat = handle.requests.find((r) => r.role === "parent")!;
  expect(seat.tools, "the seat's roster was not recorded at all — the absence assertions below would be vacuous").toContain("agent");
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(seat.tools, `🔴 github: the SEAT was offered ${verb} — the work plane is not the worker's any more`).not.toContain(verb);
  }
}

test("GitHub: a delegated worker woken by a real issue_comment holds read_work_channel/read_work_thread", async () => {
  await bootAgent();
  await pinShippedFixture();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "take it from here" }, id: "ope1119-delegate" }] }, { say: "handed off" }],
      child: [{ calls: [{ tool: "read_work_channel", input: { limit: 5 }, id: "ope1119-work-read" }] }, { say: "reported" }],
    }),
  );

  const res = await githubIssueCommentPost({
    owner: OWNER,
    repo: REPO,
    issueNumber: 1119,
    body: "ope1119 — please take a look at this thread when you get a chance",
    commentId: Number.parseInt(randomBytes(4).toString("hex"), 16),
  });
  expect(res.status, `the GitHub front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "github: the dispatch turn's own terminal step");

  const taskId = taskIdOfDelegation(handle, "the ope1119 delegation");
  const drainHandle = disposeLater(armSettlement(handle, SETTLEMENT_DRAIN_SCRIPT));

  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "github: the worker's terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "github: the scripted model reported a fault").toEqual([]);

  await consumeSettlement({ armed: drainHandle, dispatched: handle, taskId, label: "github: the worker's settlement wake" });
  expect(drainHandle.requests.filter((r) => r.fault !== undefined), "github: a straggling worker crossed into the drain").toEqual([]);
  drainHandle.dispose();

  assertWorkerHoldsWorkReads(handle);

  const read = (() => {
    for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "read_work_channel") return t;
    return undefined;
  })();
  expect(read, "the worker never got a read_work_channel result at all").toBeDefined();
  const output = String(read!.output);
  expect(
    output,
    `🔴 github: the work read was refused by the GRANT, not by the missing vendor credential — the repo grant never reached the gate. Got: ${output.slice(0, 300)}`,
  ).not.toContain("holds no github work grant");
  expect(
    output,
    `github: the work read stopped somewhere new — it should reach the vendor credential and no further at this tier. Got: ${output.slice(0, 300)}`,
  ).toContain("no GitHub credential");
}, 420_000);
