import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkCronDefinitionCount,
  checkCronDeploymentId,
  checkCronUpdatedAt,
  chooseRollbackTarget,
  createVercelClient,
  decideAfterProbe,
  DeployConfigError,
  fetchProjectInfo,
  fileStore,
  parseArgs,
  parseDeploymentList,
  parseInspect,
  parseState,
  parseVercelAuthToken,
  probeHealth,
  probeUrl,
  readLocalCronCount,
  readState,
  recordGood,
  resolveControlToken,
  resolveDeployEnv,
  resolveProjectRef,
  resolveVercelApiToken,
  runCronCheck,
  runRecord,
  runRollback,
  writeState,
  type ApiFetchLike,
  type DeployEntry,
  type DeployState,
  type Exec,
  type ExecResult,
  type FetchLike,
} from "./deploy/lib.js";

const scratch = mkdtempSync(join(tmpdir(), "oe-deploy-test-"));
let checks = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> | void => {
  checks++;
  return fn() as void;
};

check("resolveDeployEnv requires OE_DEPLOY_SCOPE by name", () => {
  assert.throws(
    () => resolveDeployEnv({ OE_DEPLOY_ALIAS: "a.vercel.app" }),
    (err: unknown) => err instanceof DeployConfigError && /OE_DEPLOY_SCOPE/.test((err as Error).message),
  );
});

check("resolveDeployEnv requires OE_DEPLOY_ALIAS by name", () => {
  assert.throws(
    () => resolveDeployEnv({ OE_DEPLOY_SCOPE: "team" }),
    (err: unknown) => err instanceof DeployConfigError && /OE_DEPLOY_ALIAS/.test((err as Error).message),
  );
});

check("resolveDeployEnv treats whitespace as unset", () => {
  assert.throws(() => resolveDeployEnv({ OE_DEPLOY_SCOPE: "   ", OE_DEPLOY_ALIAS: "a.vercel.app" }), DeployConfigError);
});

check("resolveDeployEnv defaults baseUrl from the alias and resolves the state file", () => {
  const env = resolveDeployEnv({ OE_DEPLOY_SCOPE: "team", OE_DEPLOY_ALIAS: "a.vercel.app" }, "/repo");
  assert.equal(env.baseUrl, "https://a.vercel.app");
  assert.equal(env.stateFile, "/repo/.open-everywhere-deploy/known-good.json");
  assert.equal(env.project, undefined);
});

check("resolveDeployEnv honours explicit base URL, project and absolute state path", () => {
  const env = resolveDeployEnv(
    {
      OE_DEPLOY_SCOPE: "team",
      OE_DEPLOY_ALIAS: "a.vercel.app",
      OE_DEPLOY_BASE_URL: "https://staging.example.com/",
      OE_DEPLOY_PROJECT: "my-agent",
      OE_DEPLOY_STATE_FILE: "/var/tmp/known-good.json",
    },
    "/repo",
  );
  assert.equal(env.baseUrl, "https://staging.example.com");
  assert.equal(env.project, "my-agent");
  assert.equal(env.stateFile, "/var/tmp/known-good.json");
});

check("resolveControlToken accepts either variable and names both when unset", () => {
  assert.equal(resolveControlToken({ OE_DEPLOY_CONTROL_TOKEN: "tok" }), "tok");
  assert.equal(resolveControlToken({ E2E_CONTROL_READ_TOKEN: "tok2" }), "tok2");
  assert.equal(resolveControlToken({ OE_DEPLOY_CONTROL_TOKEN: "a", E2E_CONTROL_READ_TOKEN: "b" }), "a");
  assert.throws(
    () => resolveControlToken({}),
    (err: unknown) =>
      err instanceof DeployConfigError &&
      /OE_DEPLOY_CONTROL_TOKEN/.test((err as Error).message) &&
      /E2E_CONTROL_READ_TOKEN/.test((err as Error).message),
  );
});

const LS_FIXTURE = `Deployments under team-slug:

  Age     Deployment                                       Status      Environment     Duration     Username
  2m      https://my-agent-9f2h1kq0x.vercel.app            ● Ready     Production      1m           operator
  1h      https://my-agent-7c1a2bb3z.vercel.app            ● Error     Production      45s          operator
  3h      https://my-agent-1d0e5ff9y.vercel.app            ● Ready     Production      1m           operator
  4h      https://my-agent-2b8c7aa1w.vercel.app            ● Ready     Preview         55s          operator
`;

check("parseDeploymentList reads rows newest-first with state and target", () => {
  const rows = parseDeploymentList(LS_FIXTURE);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].url, "https://my-agent-9f2h1kq0x.vercel.app");
  assert.equal(rows[0].state, "READY");
  assert.equal(rows[0].target, "PRODUCTION");
  assert.equal(rows[1].state, "ERROR");
  assert.equal(rows[3].target, "PREVIEW");
});

check("parseDeploymentList skips header/blank lines and ignores a bare 'url' column word", () => {
  assert.deepEqual(parseDeploymentList("Age  url  Status\n\n   \n"), []);
});

check("parseDeploymentList tolerates a bare-hostname table (older CLI shape)", () => {
  const rows = parseDeploymentList("  2m  my-agent-abc.vercel.app  READY  production\n");
  assert.equal(rows.length, 0);
});

const INSPECT_FIXTURE = `Fetched deployment "my-agent.vercel.app" in team-slug [1s]

  General

    id\t\t\tdpl_5RkGqXyZ11223344
    name\t\t\tmy-agent
    status\t\t\tREADY
    url\t\t\tmy-agent-9f2h1kq0x.vercel.app
    created\t\t\t2026-08-10T09:00:00.000Z
`;

check("parseInspect extracts id, url (normalised to https), status and created", () => {
  const inspected = parseInspect(INSPECT_FIXTURE);
  assert.equal(inspected.id, "dpl_5RkGqXyZ11223344");
  assert.equal(inspected.url, "https://my-agent-9f2h1kq0x.vercel.app");
  assert.equal(inspected.state, "READY");
  assert.equal(inspected.createdAt, "2026-08-10T09:00:00.000Z");
});

check("parseInspect returns empty on unrecognised output rather than throwing", () => {
  assert.deepEqual(parseInspect("Error: not found"), {});
});

const entry = (url: string, at: string, extra: Partial<DeployEntry> = {}): DeployEntry => ({ url, recordedAt: at, ...extra });

check("readState on a missing file is empty, never a throw", () => {
  const state = readState(join(scratch, "does-not-exist.json"));
  assert.deepEqual(state, { version: 1, history: [] });
});

check("parseState on corrupt JSON is empty — a broken pointer must never block a rollback", () => {
  assert.deepEqual(parseState("{not json"), { version: 1, history: [] });
  assert.deepEqual(parseState('{"version":1,"history":[{"nope":true}]}'), { version: 1, history: [] });
});

check("writeState/readState round-trip", () => {
  const path = join(scratch, "nested", "known-good.json");
  const state = { version: 1 as const, lastGood: entry("https://a.vercel.app", "2026-08-10T00:00:00.000Z"), history: [] };
  writeState(path, state);
  assert.deepEqual(readState(path), state);
});

check("recordGood demotes the previous lastGood into history", () => {
  const first = recordGood({ version: 1, history: [] }, entry("https://a", "t1"));
  const second = recordGood(first, entry("https://b", "t2"));
  assert.equal(second.lastGood?.url, "https://b");
  assert.deepEqual(second.history.map((e) => e.url), ["https://a"]);
});

check("recordGood is idempotent for the same url (history cannot be flushed by re-recording)", () => {
  let state = recordGood({ version: 1, history: [] }, entry("https://a", "t1"));
  state = recordGood(state, entry("https://b", "t2"));
  state = recordGood(state, entry("https://b", "t3"));
  state = recordGood(state, entry("https://b", "t4"));
  assert.equal(state.lastGood?.recordedAt, "t4");
  assert.deepEqual(state.history.map((e) => e.url), ["https://a"]);
});

check("recordGood bounds history at 10 and never keeps a duplicate url", () => {
  let state: DeployState = { version: 1, history: [] };
  for (let i = 0; i < 15; i++) state = recordGood(state, entry(`https://d${i}`, `t${i}`));
  assert.equal(state.history.length, 10);
  assert.equal(new Set(state.history.map((e) => e.url)).size, 10);
  assert.equal(state.lastGood?.url, "https://d14");
});

const rows = parseDeploymentList(LS_FIXTURE);

check("chooseRollbackTarget: --to always wins, and is normalised", () => {
  const choice = chooseRollbackTarget({
    explicitTo: "my-agent-old.vercel.app/",
    state: { version: 1, lastGood: entry("https://pointer", "t"), history: [] },
    currentUrl: "https://current",
    discovered: rows,
  });
  assert.equal(choice.kind, "explicit");
  assert.equal(choice.url, "https://my-agent-old.vercel.app");
});

check("chooseRollbackTarget: the pointer wins over discovery", () => {
  const choice = chooseRollbackTarget({
    state: { version: 1, lastGood: entry("https://known-good", "2026-08-10T00:00:00.000Z", { commit: "abc1234" }), history: [] },
    currentUrl: "https://my-agent-9f2h1kq0x.vercel.app",
    discovered: rows,
  });
  assert.equal(choice.kind, "pointer");
  assert.equal(choice.url, "https://known-good");
  assert.match(choice.why, /abc1234/);
});

check("chooseRollbackTarget: alias already on lastGood steps back one hop", () => {
  const choice = chooseRollbackTarget({
    state: { version: 1, lastGood: entry("https://same", "t2"), history: [entry("https://older", "t1")] },
    currentUrl: "https://same",
    discovered: [],
  });
  assert.equal(choice.kind, "pointer-history");
  assert.equal(choice.url, "https://older");
});

check("chooseRollbackTarget: no pointer → newest READY deployment that is not the current one", () => {
  const choice = chooseRollbackTarget({
    state: { version: 1, history: [] },
    currentUrl: "https://my-agent-9f2h1kq0x.vercel.app",
    discovered: rows,
  });
  assert.equal(choice.kind, "discovered");
  assert.equal(choice.url, "https://my-agent-1d0e5ff9y.vercel.app");
});

check("chooseRollbackTarget: nothing to roll back to is 'none', with an actionable why", () => {
  const choice = chooseRollbackTarget({
    state: { version: 1, history: [] },
    currentUrl: "https://only.vercel.app",
    discovered: parseDeploymentList("  2m  https://only.vercel.app  ● Ready  Production\n"),
  });
  assert.equal(choice.kind, "none");
  assert.match(choice.why, /--to/);
});

check("chooseRollbackTarget: alias on lastGood with NO history falls through to discovery", () => {
  const choice = chooseRollbackTarget({
    state: { version: 1, lastGood: entry("https://my-agent-9f2h1kq0x.vercel.app", "t"), history: [] },
    currentUrl: "https://my-agent-9f2h1kq0x.vercel.app",
    discovered: rows,
  });
  assert.equal(choice.kind, "discovered");
  assert.equal(choice.url, "https://my-agent-1d0e5ff9y.vercel.app");
});

check("probeUrl targets the audit read route with an ISO lookback", () => {
  const url = probeUrl("https://a.vercel.app/", new Date("2026-08-08T12:00:00.000Z"));
  assert.equal(url, `https://a.vercel.app/control/v1/audit?since=${encodeURIComponent("2026-08-10T11:00:00.000Z")}`);
});

await check("probeHealth sends a bearer header and stops on the first 200", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { status: 200 };
  };
  const outcome = await probeHealth({ baseUrl: "https://a.vercel.app", token: "s3cret", fetchImpl, attempts: 3 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer s3cret");
});

await check("probeHealth retries a 500 and reports the last status", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return { status: 500 };
  };
  const outcome = await probeHealth({
    baseUrl: "https://a.vercel.app",
    token: "t",
    fetchImpl,
    attempts: 3,
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 500);
  assert.equal(outcome.attempts, 3);
});

await check("probeHealth recovers when a later attempt succeeds (cold start)", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => ({ status: ++calls < 3 ? 503 : 200 });
  const outcome = await probeHealth({ baseUrl: "https://a", token: "t", fetchImpl, attempts: 5, sleep: async () => {} });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 3);
});

await check("probeHealth turns a network throw into a failed outcome, not an exception", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const outcome = await probeHealth({ baseUrl: "https://a", token: "t", fetchImpl, attempts: 2, sleep: async () => {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /ECONNREFUSED/);
});

check("decideAfterProbe: 200 passes; 5xx rolls back; --no-rollback downgrades to a plain failure", () => {
  assert.equal(decideAfterProbe({ outcome: { ok: true, status: 200, url: "u", attempts: 1 }, noRollback: false }).action, "pass");
  assert.equal(decideAfterProbe({ outcome: { ok: false, status: 500, url: "u", attempts: 3 }, noRollback: false }).action, "rollback");
  assert.equal(decideAfterProbe({ outcome: { ok: false, status: 500, url: "u", attempts: 3 }, noRollback: true }).action, "fail");
  assert.equal(
    decideAfterProbe({ outcome: { ok: false, error: "ECONNREFUSED", url: "u", attempts: 3 }, noRollback: false }).action,
    "rollback",
  );
});

check("decideAfterProbe: 401 and 404 never auto-roll-back (the deployment ANSWERED)", () => {
  const unauthorized = decideAfterProbe({ outcome: { ok: false, status: 401, url: "u", attempts: 1 }, noRollback: false });
  assert.equal(unauthorized.action, "fail");
  assert.match(unauthorized.message, /token/i);
  const notFound = decideAfterProbe({ outcome: { ok: false, status: 404, url: "u", attempts: 1 }, noRollback: false });
  assert.equal(notFound.action, "fail");
  assert.match(notFound.message, /OE_CONTROL_READ_TOKENS/);
});

type Call = { command: string; args: string[] };

function stubExec(responses: (call: Call) => ExecResult): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    return responses({ command, args });
  };
  return { exec, calls };
}

const ENV = resolveDeployEnv({ OE_DEPLOY_SCOPE: "team-slug", OE_DEPLOY_ALIAS: "my-agent.vercel.app" }, scratch);

function memoryStore(initial: DeployState = { version: 1, history: [] }) {
  let state: DeployState = initial;
  return {
    read: () => state,
    write: (next: DeployState) => {
      state = next;
    },
    get current() {
      return state;
    },
  };
}

await check("runRollback: re-points the alias at the pointer's known-good and confirms it", async () => {
  let aliased = "https://my-agent-broken.vercel.app";
  const { exec, calls } = stubExec(({ args }) => {
    if (args[0] === "inspect") return { code: 0, stdout: `id\tdpl_1\nurl\t${aliased.replace("https://", "")}\n`, stderr: "" };
    if (args[0] === "alias") {
      aliased = args[2];
      return { code: 0, stdout: "", stderr: "Success! Assigned alias" };
    }
    return { code: 0, stdout: LS_FIXTURE, stderr: "" };
  });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({ env: ENV, client: createVercelClient(ENV, exec), store, log: (l) => lines.push(l) });

  assert.equal(result.ok, true);
  assert.equal(result.target, "https://my-agent-good.vercel.app");
  const aliasCall = calls.find((c) => c.args[0] === "alias");
  assert.deepEqual(aliasCall?.args, ["alias", "set", "https://my-agent-good.vercel.app", "my-agent.vercel.app", "--scope", "team-slug"]);
  assert.ok(lines.some((l) => l.startsWith("✓ rollback")));
});

await check("runRollback: --dry-run touches nothing", async () => {
  const { exec, calls } = stubExec(({ args }) =>
    args[0] === "inspect" ? { code: 0, stdout: "id\tdpl_1\nurl\tmy-agent-broken.vercel.app\n", stderr: "" } : { code: 0, stdout: LS_FIXTURE, stderr: "" },
  );
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const result = await runRollback({ env: ENV, client: createVercelClient(ENV, exec), store, dryRun: true, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls.some((c) => c.args[0] === "alias"), false);
});

await check("runRollback: a no-op rollback FAILS rather than reporting green", async () => {
  const { exec } = stubExec(({ args }) =>
    args[0] === "inspect" ? { code: 0, stdout: "id\tdpl_1\nurl\tmy-agent-good.vercel.app\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
  );
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({
    env: ENV,
    client: createVercelClient(ENV, exec),
    store,
    explicitTo: "https://my-agent-good.vercel.app",
    log: (l) => lines.push(l),
  });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /ALREADY on/.test(l)));
});

await check("runRollback: a non-zero `vercel alias set` is a failure, not a silent pass", async () => {
  const { exec } = stubExec(({ args }) => {
    if (args[0] === "inspect") return { code: 0, stdout: "id\tdpl_1\nurl\tmy-agent-broken.vercel.app\n", stderr: "" };
    if (args[0] === "alias") return { code: 1, stdout: "", stderr: "Error: not authorized" };
    return { code: 0, stdout: LS_FIXTURE, stderr: "" };
  });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const result = await runRollback({ env: ENV, client: createVercelClient(ENV, exec), store, log: () => {} });
  assert.equal(result.ok, false);
});

await check("runRollback: a usable pointer means `vercel ls` is never called (works when listing is down)", async () => {
  const { exec, calls } = stubExec(({ args }) =>
    args[0] === "inspect"
      ? { code: 0, stdout: "id\tdpl_1\nurl\tmy-agent-broken.vercel.app\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "Error: listing unavailable" },
  );
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const result = await runRollback({ env: ENV, client: createVercelClient(ENV, exec), store, dryRun: true, log: () => {} });
  assert.equal(result.target, "https://my-agent-good.vercel.app");
  assert.equal(calls.some((c) => c.args[0] === "ls"), false);
});

await check("runRollback: with no pointer it discovers from `vercel ls`", async () => {
  let aliased = "https://my-agent-9f2h1kq0x.vercel.app";
  const { exec } = stubExec(({ args }) => {
    if (args[0] === "inspect") return { code: 0, stdout: `id\tdpl_1\nurl\t${aliased.replace("https://", "")}\n`, stderr: "" };
    if (args[0] === "alias") {
      aliased = args[2];
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: LS_FIXTURE, stderr: "" };
  });
  const result = await runRollback({ env: ENV, client: createVercelClient(ENV, exec), store: memoryStore(), log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.choice.kind, "discovered");
  assert.equal(result.target, "https://my-agent-1d0e5ff9y.vercel.app");
});

await check("runRollback: `vercel ls` narrows to OE_DEPLOY_PROJECT when set", async () => {
  const projectEnv = resolveDeployEnv(
    { OE_DEPLOY_SCOPE: "team-slug", OE_DEPLOY_ALIAS: "my-agent.vercel.app", OE_DEPLOY_PROJECT: "my-agent" },
    scratch,
  );
  const { exec, calls } = stubExec(({ args }) =>
    args[0] === "inspect" ? { code: 0, stdout: "id\tdpl_1\nurl\tsomething-else.vercel.app\n", stderr: "" } : { code: 0, stdout: LS_FIXTURE, stderr: "" },
  );
  await runRollback({ env: projectEnv, client: createVercelClient(projectEnv, exec), store: memoryStore(), dryRun: true, log: () => {} });
  assert.deepEqual(calls.find((c) => c.args[0] === "ls")?.args, ["ls", "my-agent", "--scope", "team-slug"]);
});

await check("runRecord: stamps whatever the alias points at, with commit and note", async () => {
  const { exec } = stubExec(() => ({ code: 0, stdout: "id\tdpl_9\nurl\tmy-agent-9f2h1kq0x.vercel.app\n", stderr: "" }));
  const store = memoryStore();
  const result = await runRecord({
    env: ENV,
    client: createVercelClient(ENV, exec),
    store,
    commit: "d67ab396",
    note: "OPE-376",
    now: new Date("2026-08-08T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entry, {
    url: "https://my-agent-9f2h1kq0x.vercel.app",
    id: "dpl_9",
    commit: "d67ab396",
    recordedAt: "2026-08-08T12:00:00.000Z",
    note: "OPE-376",
  });
  assert.equal(store.current.lastGood?.url, "https://my-agent-9f2h1kq0x.vercel.app");
});

await check("runRecord: --url wins over discovery", async () => {
  const { exec, calls } = stubExec(() => ({ code: 0, stdout: "", stderr: "" }));
  const store = memoryStore();
  const result = await runRecord({
    env: ENV,
    client: createVercelClient(ENV, exec),
    store,
    url: "my-agent-explicit.vercel.app",
    now: new Date("2026-08-08T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.entry?.url, "https://my-agent-explicit.vercel.app");
  assert.equal(calls.length, 0, "an explicit --url must not shell out at all");
});

await check("runRecord: fails loudly when nothing can be resolved", async () => {
  const { exec } = stubExec(() => ({ code: 1, stdout: "", stderr: "Error: deployment not found" }));
  const lines: string[] = [];
  const result = await runRecord({ env: ENV, client: createVercelClient(ENV, exec), store: memoryStore(), log: (l) => lines.push(l) });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /--url/.test(l)));
});

await check("runRollback reads a real on-disk pointer through fileStore", async () => {
  const path = join(scratch, "pointer", "known-good.json");
  writeState(path, { version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const { exec } = stubExec(({ args }) =>
    args[0] === "inspect" ? { code: 0, stdout: "id\tdpl_1\nurl\tmy-agent-broken.vercel.app\n", stderr: "" } : { code: 0, stdout: LS_FIXTURE, stderr: "" },
  );
  const result = await runRollback({
    env: ENV,
    client: createVercelClient(ENV, exec),
    store: fileStore(path),
    dryRun: true,
    log: () => {},
  });
  assert.equal(result.target, "https://my-agent-good.vercel.app");
});

check("checkCronDeploymentId: passes when the ids match", () => {
  const outcome = checkCronDeploymentId({ crons: { deploymentId: "dpl_current" }, resolvedDeploymentId: "dpl_current" });
  assert.equal(outcome.kind, "pass");
});

check("checkCronDeploymentId: FAILS LOUD on a deliberately wrong deployment id", () => {
  const outcome = checkCronDeploymentId({ crons: { deploymentId: "dpl_stale_22_days" }, resolvedDeploymentId: "dpl_current" });
  assert.equal(outcome.kind, "fail");
  assert.match(outcome.message, /dpl_stale_22_days/);
  assert.match(outcome.message, /dpl_current/);
  assert.match(outcome.message, /vercel deploy --prod/);
});

check("checkCronDeploymentId: warns (not fails) when the field is missing — fail-soft", () => {
  const outcome = checkCronDeploymentId({ crons: {}, resolvedDeploymentId: "dpl_current" });
  assert.equal(outcome.kind, "warn");
  assert.match(outcome.message, /deploymentId/);
});

check("checkCronDeploymentId: warns when the field is renamed to a non-string", () => {
  const outcome = checkCronDeploymentId({ crons: { deploymentId: 12345 }, resolvedDeploymentId: "dpl_current" });
  assert.equal(outcome.kind, "warn");
});

check("checkCronDeploymentId: warns when the alias-resolved id itself is unknown", () => {
  const outcome = checkCronDeploymentId({ crons: { deploymentId: "dpl_x" }, resolvedDeploymentId: undefined });
  assert.equal(outcome.kind, "warn");
  assert.match(outcome.message, /vercel inspect/);
});

check("checkCronDefinitionCount: passes when the counts match", () => {
  const outcome = checkCronDefinitionCount({
    crons: { definitions: [{ path: "/a" }, { path: "/b" }] },
    local: { kind: "count", count: 2 },
  });
  assert.equal(outcome.kind, "pass");
});

check("checkCronDefinitionCount: FAILS LOUD on a real mismatch", () => {
  const outcome = checkCronDefinitionCount({
    crons: { definitions: [{ path: "/a" }, { path: "/b" }, { path: "/c" }] },
    local: { kind: "count", count: 1 },
  });
  assert.equal(outcome.kind, "fail");
  assert.match(outcome.message, /3 registered/);
  assert.match(outcome.message, /declares 1/);
});

check("checkCronDefinitionCount: a local build with NO crons key is a real count of zero, not a skip", () => {
  const outcome = checkCronDefinitionCount({ crons: { definitions: [{ path: "/a" }] }, local: { kind: "count", count: 0 } });
  assert.equal(outcome.kind, "fail");
});

check("checkCronDefinitionCount: warns (not fails) when .vercel/output/config.json is absent", () => {
  const outcome = checkCronDefinitionCount({ crons: { definitions: [] }, local: { kind: "absent" } });
  assert.equal(outcome.kind, "warn");
  assert.match(outcome.message, /not found locally/);
});

check("checkCronDefinitionCount: warns when the local file fails to parse", () => {
  const outcome = checkCronDefinitionCount({ crons: { definitions: [] }, local: { kind: "malformed", detail: "not json" } });
  assert.equal(outcome.kind, "warn");
  assert.match(outcome.message, /not json/);
});

check("checkCronDefinitionCount: warns when crons.definitions is missing from the API response", () => {
  const outcome = checkCronDefinitionCount({ crons: {}, local: { kind: "count", count: 2 } });
  assert.equal(outcome.kind, "warn");
});

check("checkCronUpdatedAt: passes when the registration is newer than the deployment", () => {
  const outcome = checkCronUpdatedAt({
    crons: { updatedAt: Date.parse("2026-08-10T10:00:00.000Z") },
    deploymentCreatedAt: "2026-08-10T09:00:00.000Z",
  });
  assert.equal(outcome.kind, "pass");
});

check("checkCronUpdatedAt: FAILS LOUD when the registration predates the deployment", () => {
  const outcome = checkCronUpdatedAt({
    crons: { updatedAt: Date.parse("2026-07-19T00:00:00.000Z") },
    deploymentCreatedAt: "2026-08-10T09:00:00.000Z",
  });
  assert.equal(outcome.kind, "fail");
  assert.match(outcome.message, /OLDER/);
});

check("checkCronUpdatedAt: warns (not fails) when updatedAt is missing", () => {
  const outcome = checkCronUpdatedAt({ crons: {}, deploymentCreatedAt: "2026-08-10T09:00:00.000Z" });
  assert.equal(outcome.kind, "warn");
});

check("checkCronUpdatedAt: warns when updatedAt cannot be parsed as a date", () => {
  const outcome = checkCronUpdatedAt({ crons: { updatedAt: "not-a-date" }, deploymentCreatedAt: "2026-08-10T09:00:00.000Z" });
  assert.equal(outcome.kind, "warn");
});

check("checkCronUpdatedAt: warns when the deployment's created timestamp is unknown", () => {
  const outcome = checkCronUpdatedAt({ crons: { updatedAt: Date.parse("2026-08-10T10:00:00.000Z") }, deploymentCreatedAt: undefined });
  assert.equal(outcome.kind, "warn");
});

check("readLocalCronCount: a missing file is 'absent'", () => {
  assert.deepEqual(readLocalCronCount("/does/not/exist.json", () => undefined), { kind: "absent" });
});

check("readLocalCronCount: invalid JSON is 'malformed'", () => {
  const result = readLocalCronCount("x", () => "{not json");
  assert.equal(result.kind, "malformed");
});

check("readLocalCronCount: no crons key is a real count of zero", () => {
  assert.deepEqual(readLocalCronCount("x", () => JSON.stringify({ version: 3 })), { kind: "count", count: 0 });
});

check("readLocalCronCount: counts the crons array", () => {
  assert.deepEqual(readLocalCronCount("x", () => JSON.stringify({ crons: [{ path: "/a", schedule: "*/10 * * * *" }, { path: "/b", schedule: "0 0 * * *" }] })), {
    kind: "count",
    count: 2,
  });
});

check("readLocalCronCount: a non-array crons field is 'malformed'", () => {
  const result = readLocalCronCount("x", () => JSON.stringify({ crons: "nope" }));
  assert.equal(result.kind, "malformed");
});

check("resolveProjectRef: OE_DEPLOY_PROJECT wins, and never touches the filesystem", () => {
  let read = false;
  const ref = resolveProjectRef({
    envProject: "my-agent",
    envScope: "team-slug",
    projectJsonPath: "/repo/.vercel/project.json",
    readFile: () => {
      read = true;
      return undefined;
    },
  });
  assert.deepEqual(ref, { idOrName: "my-agent", teamSlug: "team-slug" });
  assert.equal(read, false);
});

check("resolveProjectRef: falls back to .vercel/project.json's projectId", () => {
  const ref = resolveProjectRef({
    envScope: "team-slug",
    projectJsonPath: "/repo/.vercel/project.json",
    readFile: (p) => (p === "/repo/.vercel/project.json" ? JSON.stringify({ projectId: "prj_abc123", orgId: "team_xyz" }) : undefined),
  });
  assert.deepEqual(ref, { idOrName: "prj_abc123", teamSlug: "team-slug" });
});

check("resolveProjectRef: undefined when neither the env var nor the file resolves anything", () => {
  const ref = resolveProjectRef({ envScope: "team-slug", projectJsonPath: "/repo/.vercel/project.json", readFile: () => undefined });
  assert.equal(ref, undefined);
});

check("parseVercelAuthToken: reads the token field, and is defensive on garbage", () => {
  assert.equal(parseVercelAuthToken(JSON.stringify({ token: "tok_abc" })), "tok_abc");
  assert.equal(parseVercelAuthToken("{not json"), undefined);
  assert.equal(parseVercelAuthToken(JSON.stringify({ noToken: true })), undefined);
});

check("resolveVercelApiToken: VERCEL_TOKEN wins over the CLI's stored login", () => {
  const token = resolveVercelApiToken({ env: { VERCEL_TOKEN: "env-token" }, readFile: () => JSON.stringify({ token: "file-token" }) });
  assert.equal(token, "env-token");
});

check("resolveVercelApiToken: falls back to the CLI's stored login when unset", () => {
  const token = resolveVercelApiToken({ env: {}, homeDir: "/home/op", readFile: (p) => (p.endsWith("com.vercel.cli/auth.json") ? JSON.stringify({ token: "cli-token" }) : undefined) });
  assert.equal(token, "cli-token");
});

check("resolveVercelApiToken: undefined when nothing is found anywhere", () => {
  const token = resolveVercelApiToken({ env: {}, homeDir: "/home/op", readFile: () => undefined });
  assert.equal(token, undefined);
});

await check("fetchProjectInfo: parses a 200 body", async () => {
  const fetchImpl: ApiFetchLike = async (url) => {
    assert.match(url, /\/v9\/projects\/prj_abc/);
    assert.match(url, /slug=team-slug/);
    return { status: 200, text: async () => JSON.stringify({ crons: { deploymentId: "dpl_1" } }) };
  };
  const result = await fetchProjectInfo({ project: { idOrName: "prj_abc", teamSlug: "team-slug" }, token: "tok", fetchImpl });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { crons: { deploymentId: "dpl_1" } });
});

await check("fetchProjectInfo: sends the bearer token and reports a non-200 without throwing", async () => {
  let seenAuth: string | undefined;
  const fetchImpl: ApiFetchLike = async (_url, init) => {
    seenAuth = init.headers.authorization;
    return { status: 404, text: async () => JSON.stringify({ error: "not found" }) };
  };
  const result = await fetchProjectInfo({ project: { idOrName: "prj_abc", teamSlug: "team-slug" }, token: "s3cret", fetchImpl });
  assert.equal(result.status, 404);
  assert.equal(seenAuth, "Bearer s3cret");
});

await check("fetchProjectInfo: an unparsable 200 body is reported, not thrown", async () => {
  const fetchImpl: ApiFetchLike = async () => ({ status: 200, text: async () => "not json" });
  const result = await fetchProjectInfo({ project: { idOrName: "prj_abc", teamSlug: "team-slug" }, token: "t", fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(result.body, undefined);
  assert.ok(result.parseError);
});

const matchingProjectBody = () =>
  JSON.stringify({
    crons: {
      deploymentId: "dpl_current",
      updatedAt: Date.parse("2026-08-10T10:00:00.000Z"),
      definitions: [{ host: "my-agent-current.vercel.app", path: "/eve/cron/routines", schedule: "*/10 * * * *" }],
    },
  });

await check("runCronCheck: a fully matching fixture passes every check", async () => {
  const lines: string[] = [];
  const result = await runCronCheck({
    token: "tok",
    project: { idOrName: "prj_abc", teamSlug: "team-slug" },
    resolvedDeploymentId: "dpl_current",
    deploymentCreatedAt: "2026-08-10T09:00:00.000Z",
    localCrons: { kind: "count", count: 1 },
    apiFetch: async () => ({ status: 200, text: async () => matchingProjectBody() }),
    log: (l) => lines.push(l),
  });
  assert.equal(result.ran, true);
  assert.equal(result.ok, true);
  assert.ok(result.outcomes.every((o) => o.kind === "pass"));
  assert.ok(lines.some((l) => l.includes("✓")));
});

await check("runCronCheck: a deliberately wrong deployment id fails the whole check loudly", async () => {
  const result = await runCronCheck({
    token: "tok",
    project: { idOrName: "prj_abc", teamSlug: "team-slug" },
    resolvedDeploymentId: "dpl_current",
    deploymentCreatedAt: "2026-08-10T09:00:00.000Z",
    localCrons: { kind: "count", count: 1 },
    apiFetch: async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          crons: {
            deploymentId: "dpl_STALE_INJECTED_FOR_TEST",
            updatedAt: Date.parse("2026-08-10T10:00:00.000Z"),
            definitions: [{ host: "x", path: "/eve/cron/routines", schedule: "*/10 * * * *" }],
          },
        }),
    }),
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.outcomes.some((o) => o.kind === "fail" && /dpl_STALE_INJECTED_FOR_TEST/.test(o.message)));
});

await check("runCronCheck: a missing field warns per-check but the OVERALL result still passes", async () => {
  const result = await runCronCheck({
    token: "tok",
    project: { idOrName: "prj_abc", teamSlug: "team-slug" },
    resolvedDeploymentId: "dpl_current",
    deploymentCreatedAt: "2026-08-10T09:00:00.000Z",
    localCrons: { kind: "count", count: 1 },
    apiFetch: async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          crons: {
            updatedAt: Date.parse("2026-08-10T10:00:00.000Z"),
            definitions: [{ host: "x", path: "/eve/cron/routines", schedule: "*/10 * * * *" }],
          },
        }),
    }),
    log: () => {},
  });
  assert.equal(result.ran, true);
  assert.equal(result.ok, true);
  assert.equal(result.outcomes.filter((o) => o.kind === "warn").length, 1);
  assert.equal(result.outcomes.filter((o) => o.kind === "pass").length, 2);
});

await check("runCronCheck: no token skips cleanly (ok:true, ran:false), never throws", async () => {
  const lines: string[] = [];
  const result = await runCronCheck({
    token: undefined,
    project: { idOrName: "prj_abc", teamSlug: "team-slug" },
    localCrons: { kind: "absent" },
    apiFetch: async () => {
      throw new Error("must not be called without a token");
    },
    log: (l) => lines.push(l),
  });
  assert.equal(result.ran, false);
  assert.equal(result.ok, true);
  assert.ok(lines.some((l) => /token/.test(l)));
});

await check("runCronCheck: no resolvable project skips cleanly", async () => {
  const result = await runCronCheck({
    token: "tok",
    project: undefined,
    localCrons: { kind: "absent" },
    apiFetch: async () => {
      throw new Error("must not be called without a project");
    },
    log: () => {},
  });
  assert.equal(result.ran, false);
  assert.equal(result.ok, true);
});

await check("runCronCheck: a non-200 API response skips cleanly rather than blocking the deploy", async () => {
  const result = await runCronCheck({
    token: "tok",
    project: { idOrName: "prj_abc", teamSlug: "team-slug" },
    localCrons: { kind: "absent" },
    apiFetch: async () => ({ status: 500, text: async () => "Internal Server Error" }),
    log: () => {},
  });
  assert.equal(result.ran, false);
  assert.equal(result.ok, true);
});

check("parseArgs handles --flag, --key value and --key=value", () => {
  const args = parseArgs(["--dry-run", "--to", "https://x", "--attempts=5", "positional"]);
  assert.equal(args.flags.has("dry-run"), true);
  assert.equal(args.values.get("to"), "https://x");
  assert.equal(args.values.get("attempts"), "5");
  assert.deepEqual(args.positional, ["positional"]);
});

check("parseArgs treats a trailing flag as a flag, not a value-eater", () => {
  const args = parseArgs(["--record", "--no-rollback"]);
  assert.equal(args.flags.has("record"), true);
  assert.equal(args.flags.has("no-rollback"), true);
  assert.equal(args.values.size, 0);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`✓ deploy: ${checks} check(s) passed (rollback selection, pointer, probe→decision, cron registration, env validation — all offline)`);
