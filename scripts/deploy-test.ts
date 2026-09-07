import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCronDefinitionCount,
  checkCronDeploymentId,
  checkCronUpdatedAt,
  chooseRollbackTarget,
  createVercelClient,
  currentAliasTarget,
  decideAfterProbe,
  DeployConfigError,
  deploymentKey,
  fetchProjectInfo,
  fileStore,
  lazyVercelClient,
  parseArgs,
  parseDeploymentList,
  parseDeploymentRecord,
  parseState,
  parseVercelAuthToken,
  probeHealth,
  probeUrl,
  readLocalCronCount,
  readState,
  realExec,
  recordGood,
  resolveControlToken,
  resolveDeployEnv,
  resolveProjectRef,
  resolveVercelApi,
  resolveVercelApiToken,
  runCronCheck,
  runRecord,
  runRollback,
  unresolvedAliasFailure,
  VercelApiError,
  writeState,
  type ApiFetchLike,
  type DeployEntry,
  type DeployState,
  type FetchLike,
  type VercelApi,
  type VercelProjectRef,
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

const LIST_FIXTURE = {
  deployments: [
    { uid: "dpl_older", url: "my-agent-1d0e5ff9y.vercel.app", created: 3_000, state: "READY", readyState: "READY", target: "production" },
    { uid: "dpl_newest", url: "my-agent-9f2h1kq0x.vercel.app", created: 9_000, state: "READY", readyState: "READY", target: "production" },
    { uid: "dpl_broken", url: "my-agent-7c1a2bb3z.vercel.app", created: 5_000, state: "ERROR", readyState: "ERROR", target: "production" },
  ],
};

check("parseDeploymentList sorts NEWEST FIRST — the order is the rollback decision", () => {
  const rows = parseDeploymentList(LIST_FIXTURE);
  assert.deepEqual(
    rows.map((r) => r.url),
    ["https://my-agent-9f2h1kq0x.vercel.app", "https://my-agent-7c1a2bb3z.vercel.app", "https://my-agent-1d0e5ff9y.vercel.app"],
  );
  assert.equal(rows[0].state, "READY");
  assert.equal(rows[0].target, "PRODUCTION");
  assert.equal(rows[1].state, "ERROR");
});

check("parseDeploymentList sorts a row with no `created` LAST — an unknown age never wins", () => {
  const rows = parseDeploymentList({ deployments: [{ url: "a.vercel.app", state: "READY" }, { url: "b.vercel.app", created: 5, state: "READY" }] });
  assert.deepEqual(rows.map((r) => r.url), ["https://b.vercel.app", "https://a.vercel.app"]);
});

check("parseDeploymentList drops rows with no url, and a body of the wrong shape is empty", () => {
  assert.equal(parseDeploymentList({ deployments: [{ uid: "dpl_x" }, { url: "" }, "nope"] }).length, 0);
  assert.deepEqual(parseDeploymentList({}), []);
  assert.deepEqual(parseDeploymentList("not an object"), []);
});

const RECORD_FIXTURE = {
  id: "dpl_5RkGqXyZ11223344",
  url: "my-agent-9f2h1kq0x.vercel.app",
  readyState: "READY",
  createdAt: 1_786_698_000_000,
};

check("parseDeploymentRecord extracts id, url (normalised to https), state and an ISO createdAt", () => {
  const record = parseDeploymentRecord(RECORD_FIXTURE);
  assert.equal(record.id, "dpl_5RkGqXyZ11223344");
  assert.equal(record.url, "https://my-agent-9f2h1kq0x.vercel.app");
  assert.equal(record.state, "READY");
  assert.equal(record.createdAt, new Date(1_786_698_000_000).toISOString());
  assert.equal(Number.isNaN(new Date(record.createdAt!).getTime()), false);
});

check("parseDeploymentRecord returns empty on a body with none of the fields, rather than throwing", () => {
  assert.deepEqual(parseDeploymentRecord({ error: { code: "not_found" } }), {});
  assert.deepEqual(parseDeploymentRecord("nope"), {});
  assert.equal(parseDeploymentRecord({ id: "dpl_1", createdAt: "yesterday" }).createdAt, undefined);
});

check("deploymentKey reduces any deployment reference to ONE path segment", () => {
  assert.equal(deploymentKey("https://my-agent-abc.vercel.app/"), "my-agent-abc.vercel.app");
  assert.equal(deploymentKey("  http://my-agent-abc.vercel.app  "), "my-agent-abc.vercel.app");
  assert.equal(deploymentKey("dpl_5RkGqXyZ11223344"), "dpl_5RkGqXyZ11223344");
  assert.equal(deploymentKey("https://my-agent-abc.vercel.app/control/v1/audit?x=1"), "my-agent-abc.vercel.app");
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

const rows = parseDeploymentList(LIST_FIXTURE);

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
    discovered: parseDeploymentList({ deployments: [{ url: "only.vercel.app", created: 1, readyState: "READY", target: "production" }] }),
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

type ApiCall = { method: string; path: string; body?: string };

const ENV = resolveDeployEnv({ OE_DEPLOY_SCOPE: "team-slug", OE_DEPLOY_ALIAS: "my-agent.vercel.app" }, scratch);
const PROJECT: VercelProjectRef = { idOrName: "prj_test", teamSlug: "team-slug", teamId: "team_abc" };
const TEST_TOKEN = "oe-1045-test-token";

type StubResponse = { status: number; body: unknown } | { status: number; text: string };

function stubApi(handler: (call: ApiCall) => StubResponse, project: VercelProjectRef = PROJECT): { api: VercelApi; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const fetchImpl: ApiFetchLike = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${TEST_TOKEN}`);
    const call: ApiCall = { method: init.method ?? "GET", path: url.replace("https://api.vercel.com", ""), ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    const res = handler(call);
    const text = "text" in res ? res.text : JSON.stringify(res.body);
    return { status: res.status, text: async () => text };
  };
  return { api: { token: TEST_TOKEN, project, fetchImpl }, calls };
}

const idFor = (host: string): string => `dpl_${host.replace(/\.vercel\.app$/, "")}`;
const hostFor = (id: string): string => `${id.replace(/^dpl_/, "")}.vercel.app`;

function fakeVercel(options: { aliasTarget?: string; list?: unknown; listStatus?: number; aliasSetStatus?: number; unknownAlias?: boolean } = {}) {
  let aliasTarget = options.aliasTarget ?? "my-agent-broken.vercel.app";
  const { api, calls } = stubApi((call) => {
    const assign = /^\/v2\/deployments\/([^/?]+)\/aliases/.exec(call.path);
    if (call.method === "POST" && assign) {
      if (options.aliasSetStatus && options.aliasSetStatus !== 200) {
        return { status: options.aliasSetStatus, body: { error: { code: "forbidden", message: "not authorized to assign that alias" } } };
      }
      aliasTarget = hostFor(decodeURIComponent(assign[1]));
      return { status: 200, body: { uid: "alias_1", alias: JSON.parse(call.body ?? "{}").alias } };
    }
    if (call.path.startsWith("/v6/deployments")) {
      if (options.listStatus && options.listStatus !== 200) return { status: options.listStatus, body: { error: { code: "server_error", message: "listing unavailable" } } };
      return { status: 200, body: options.list ?? LIST_FIXTURE };
    }
    const record = /^\/v13\/deployments\/([^?]+)/.exec(call.path);
    if (record) {
      const key = decodeURIComponent(record[1]);
      if (key === ENV.alias && options.unknownAlias) return { status: 404, body: { error: { code: "not_found", message: "deployment not found" } } };
      const host = key === ENV.alias ? aliasTarget : key.startsWith("dpl_") ? hostFor(key) : key;
      return { status: 200, body: { id: idFor(host), url: host, readyState: "READY", createdAt: 1_786_698_000_000 } };
    }
    return { status: 404, body: { error: { code: "not_found", message: `no stub for ${call.path}` } } };
  });
  return { api, calls, aliasNow: () => aliasTarget };
}

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

await check("vercelApiJson: a non-2xx THROWS with the method, path, status and Vercel's own message", async () => {
  const { api } = stubApi(() => ({ status: 403, body: { error: { code: "forbidden", message: "Not authorized" } } }));
  await assert.rejects(
    () => createVercelClient(api).inspect("my-agent.vercel.app"),
    (err: unknown) =>
      err instanceof VercelApiError &&
      /GET \/v13\/deployments\//.test((err as Error).message) &&
      /HTTP 403/.test((err as Error).message) &&
      /forbidden — Not authorized/.test((err as Error).message),
  );
});

await check("vercelApiJson: the thrown message NEVER carries the bearer token", async () => {
  const { api } = stubApi(() => ({ status: 401, text: `token ${TEST_TOKEN} rejected` }));
  const err = await createVercelClient(api)
    .inspect("my-agent.vercel.app")
    .then(() => undefined)
    .catch((e: unknown) => e as Error);
  assert.ok(err, "the call must fail");
  assert.equal(err!.message.includes(TEST_TOKEN), false, `the token must not appear in: ${err!.message}`);
});

await check("vercelApiJson: a 200 with a body that is not JSON THROWS rather than reading as empty data", async () => {
  const { api } = stubApi(() => ({ status: 200, text: "<html>gateway</html>" }));
  await assert.rejects(
    () => createVercelClient(api).inspect("my-agent.vercel.app"),
    (err: unknown) => err instanceof VercelApiError && /not JSON/.test((err as Error).message),
  );
});

await check("createVercelClient: the alias lookup is ONE call to /v13/deployments, qualified by teamId", async () => {
  const { api, calls } = fakeVercel({ aliasTarget: "my-agent-live.vercel.app" });
  const result = await createVercelClient(api).inspect("my-agent.vercel.app");
  assert.equal(calls.length, 1, "an alias must resolve in one request");
  assert.equal(calls[0].path, "/v13/deployments/my-agent.vercel.app?teamId=team_abc");
  assert.equal(result.url, "https://my-agent-live.vercel.app");
  assert.equal(result.id, "dpl_my-agent-live");
});

await check("createVercelClient: with no teamId the call falls back to slug=, never to no qualifier", async () => {
  const { api, calls } = stubApi(() => ({ status: 200, body: RECORD_FIXTURE }), { idOrName: "prj_test", teamSlug: "team-slug" });
  await createVercelClient(api).inspect("my-agent.vercel.app");
  assert.equal(calls[0].path, "/v13/deployments/my-agent.vercel.app?slug=team-slug");
});

await check("createVercelClient: the listing uses projectId= for a prj_ id and app= for a name", async () => {
  const byId = stubApi(() => ({ status: 200, body: LIST_FIXTURE }));
  await createVercelClient(byId.api).ls();
  assert.match(byId.calls[0].path, /^\/v6\/deployments\?projectId=prj_test&teamId=team_abc&limit=\d+&target=production$/);

  const byName = stubApi(() => ({ status: 200, body: LIST_FIXTURE }), { idOrName: "my-agent", teamSlug: "team-slug" });
  await createVercelClient(byName.api).ls();
  assert.match(byName.calls[0].path, /^\/v6\/deployments\?app=my-agent&slug=team-slug&limit=\d+&target=production$/);
});

await check("createVercelClient: apiBase redirects every call, so a test never reaches the real API", async () => {
  const seen: string[] = [];
  const api: VercelApi = {
    token: TEST_TOKEN,
    project: PROJECT,
    apiBase: "http://127.0.0.1:9/",
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 200, text: async () => JSON.stringify(RECORD_FIXTURE) };
    },
  };
  await createVercelClient(api).inspect("my-agent.vercel.app");
  assert.equal(seen[0], "http://127.0.0.1:9/v13/deployments/my-agent.vercel.app?teamId=team_abc");
});

await check("createVercelClient.aliasSet: names WHICH of its two steps failed", async () => {
  const lookupFailed = stubApi(() => ({ status: 404, body: { error: { code: "not_found", message: "deployment not found" } } }));
  const first = await createVercelClient(lookupFailed.api).aliasSet("https://my-agent-good.vercel.app", "my-agent.vercel.app");
  assert.equal(first.ok, false);
  assert.match(first.detail, /could not resolve https:\/\/my-agent-good\.vercel\.app to a deployment id/);

  const assignFailed = fakeVercel({ aliasSetStatus: 403 });
  const second = await createVercelClient(assignFailed.api).aliasSet("https://my-agent-good.vercel.app", "my-agent.vercel.app");
  assert.equal(second.ok, false);
  assert.match(second.detail, /POST \/v2\/deployments\/dpl_my-agent-good\/aliases/);
  assert.equal(/could not resolve/.test(second.detail), false, "step 2's failure must not be reported as step 1's");
});

await check("runRollback: re-points the alias at the pointer's known-good and confirms it", async () => {
  const vercel = fakeVercel({ aliasTarget: "my-agent-broken.vercel.app" });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store, log: (l) => lines.push(l) });

  assert.equal(result.ok, true);
  assert.equal(result.target, "https://my-agent-good.vercel.app");
  const assign = vercel.calls.find((c) => c.method === "POST");
  assert.equal(assign?.path, "/v2/deployments/dpl_my-agent-good/aliases?teamId=team_abc");
  assert.deepEqual(JSON.parse(assign?.body ?? "{}"), { alias: "my-agent.vercel.app" });
  assert.equal(vercel.aliasNow(), "my-agent-good.vercel.app", "the alias must actually have moved");
  assert.ok(lines.some((l) => l.startsWith("✓ rollback")));
});

await check("runRollback: --dry-run touches nothing", async () => {
  const vercel = fakeVercel();
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store, dryRun: true, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(vercel.calls.some((c) => c.method === "POST"), false);
  assert.equal(vercel.aliasNow(), "my-agent-broken.vercel.app");
});

await check("runRollback: a no-op rollback FAILS rather than reporting green", async () => {
  const vercel = fakeVercel({ aliasTarget: "my-agent-good.vercel.app" });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({
    env: ENV,
    client: createVercelClient(vercel.api),
    store,
    explicitTo: "https://my-agent-good.vercel.app",
    log: (l) => lines.push(l),
  });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /ALREADY on/.test(l)));
  assert.equal(vercel.calls.some((c) => c.method === "POST"), false);
});

await check("runRollback: a REFUSED alias assignment is a failure, not a silent pass", async () => {
  const vercel = fakeVercel({ aliasSetStatus: 403 });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store, log: (l) => lines.push(l) });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /alias assignment failed/.test(l)));
  assert.ok(lines.some((l) => /not authorized to assign that alias/.test(l)), "the operator must see Vercel's own reason");
});

await check("runRollback: a usable pointer means the LISTING is never fetched (works when it is down)", async () => {
  const vercel = fakeVercel({ listStatus: 500 });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store, dryRun: true, log: () => {} });
  assert.equal(result.target, "https://my-agent-good.vercel.app");
  assert.equal(vercel.calls.some((c) => c.path.startsWith("/v6/deployments")), false);
});

await check("runRollback: with no pointer it discovers from the listing", async () => {
  const vercel = fakeVercel({ aliasTarget: "my-agent-9f2h1kq0x.vercel.app" });
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store: memoryStore(), log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.choice.kind, "discovered");
  assert.equal(result.target, "https://my-agent-1d0e5ff9y.vercel.app");
});

await check("runRecord: stamps whatever the alias points at, with commit and note", async () => {
  const vercel = fakeVercel({ aliasTarget: "my-agent-9f2h1kq0x.vercel.app" });
  const store = memoryStore();
  const result = await runRecord({
    env: ENV,
    client: createVercelClient(vercel.api),
    store,
    commit: "d67ab396",
    note: "OPE-376",
    now: new Date("2026-08-08T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entry, {
    url: "https://my-agent-9f2h1kq0x.vercel.app",
    id: "dpl_my-agent-9f2h1kq0x",
    commit: "d67ab396",
    recordedAt: "2026-08-08T12:00:00.000Z",
    note: "OPE-376",
  });
  assert.equal(store.current.lastGood?.url, "https://my-agent-9f2h1kq0x.vercel.app");
});

await check("runRecord: --url wins over discovery, and reaches Vercel not at all", async () => {
  const vercel = fakeVercel();
  const store = memoryStore();
  const result = await runRecord({
    env: ENV,
    client: createVercelClient(vercel.api),
    store,
    url: "my-agent-explicit.vercel.app",
    now: new Date("2026-08-08T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.entry?.url, "https://my-agent-explicit.vercel.app");
  assert.equal(vercel.calls.length, 0, "an explicit --url must make no API call at all");
});

await check("runRecord: fails loudly when nothing can be resolved", async () => {
  const vercel = fakeVercel({ unknownAlias: true });
  const lines: string[] = [];
  const result = await runRecord({ env: ENV, client: createVercelClient(vercel.api), store: memoryStore(), log: (l) => lines.push(l) });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /--url/.test(l)));
});

await check("runRollback reads a real on-disk pointer through fileStore", async () => {
  const path = join(scratch, "pointer", "known-good.json");
  writeState(path, { version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const vercel = fakeVercel();
  const result = await runRollback({
    env: ENV,
    client: createVercelClient(vercel.api),
    store: fileStore(path),
    dryRun: true,
    log: () => {},
  });
  assert.equal(result.target, "https://my-agent-good.vercel.app");
});

await check("lazyVercelClient: builds nothing until a method is called — `deploy:record --url` needs no token", async () => {
  let built = 0;
  const vercel = fakeVercel();
  const client = lazyVercelClient(() => {
    built++;
    return vercel.api;
  });
  assert.equal(built, 0, "constructing the lazy client must not resolve any credential");
  const result = await runRecord({ env: ENV, client, store: memoryStore(), url: "my-agent-explicit.vercel.app", log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(built, 0, "an explicit --url must still never build the client");

  await client.inspect("my-agent.vercel.app");
  assert.equal(built, 1, "the first real call builds it");
  await client.inspect("my-agent.vercel.app");
  assert.equal(built, 1, "and it is built once, not per call");
});

await check("lazyVercelClient: a factory that throws surfaces at the call that needed it", async () => {
  const client = lazyVercelClient(() => {
    throw new DeployConfigError("no Vercel API token — set OE_VERCEL_API_TOKEN");
  });
  const lines: string[] = [];
  const result = await runRecord({ env: ENV, client, store: memoryStore(), log: (l) => lines.push(l) });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /OE_VERCEL_API_TOKEN/.test(l)), "the missing variable must reach the operator, not vanish");
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
  assert.match(outcome.message, /deployment record carried no id/);
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

check("resolveProjectRef: falls back to .vercel/project.json's projectId, and reads orgId as teamId", () => {
  const ref = resolveProjectRef({
    envScope: "team-slug",
    projectJsonPath: "/repo/.vercel/project.json",
    readFile: (p) => (p === "/repo/.vercel/project.json" ? JSON.stringify({ projectId: "prj_abc123", orgId: "team_xyz" }) : undefined),
  });
  assert.deepEqual(ref, { idOrName: "prj_abc123", teamSlug: "team-slug", teamId: "team_xyz" });
});

check("resolveProjectRef: a file with no orgId leaves teamId undefined", () => {
  const ref = resolveProjectRef({
    envScope: "team-slug",
    projectJsonPath: "/repo/.vercel/project.json",
    readFile: (p) => (p === "/repo/.vercel/project.json" ? JSON.stringify({ projectId: "prj_abc123" }) : undefined),
  });
  assert.deepEqual(ref, { idOrName: "prj_abc123", teamSlug: "team-slug", teamId: undefined });
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

check("resolveVercelApiToken: OE_VERCEL_API_TOKEN wins over the CLI's stored login", () => {
  const token = resolveVercelApiToken({ env: { OE_VERCEL_API_TOKEN: "env-token" }, readFile: () => JSON.stringify({ token: "file-token" }) });
  assert.equal(token, "env-token");
});

check("resolveVercelApiToken: a bare VERCEL_TOKEN is NOT read — that name is the CLI's own (OPE-1031)", () => {
  const token = resolveVercelApiToken({ env: { VERCEL_TOKEN: "cli-colliding-name" }, homeDir: "/home/op", readFile: () => undefined });
  assert.equal(token, undefined);
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

await check("fetchProjectInfo: prefers teamId over slug when both are known", async () => {
  const fetchImpl: ApiFetchLike = async (url) => {
    assert.match(url, /teamId=team_xyz/);
    assert.doesNotMatch(url, /slug=/);
    return { status: 200, text: async () => JSON.stringify({ crons: {} }) };
  };
  const result = await fetchProjectInfo({ project: { idOrName: "prj_abc", teamSlug: "team-slug", teamId: "team_xyz" }, token: "tok", fetchImpl });
  assert.equal(result.status, 200);
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

await check("realExec: a command that cannot be spawned sets spawnError — it is NOT an empty result", async () => {
  const res = await realExec("oe-1028-no-such-binary", ["--version"]);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
  assert.ok(res.spawnError, "a failed spawn must be reported, not flattened into empty output");
  assert.ok(/ENOENT/.test(res.spawnError ?? ""));
});

await check("realExec: a command that DOES run carries no spawnError", async () => {
  const res = await realExec(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(res.spawnError, undefined);
  assert.equal(res.stdout, "ok");
  assert.equal(res.code, 0);
});

const API_ENV = resolveDeployEnv({ OE_DEPLOY_SCOPE: "team-slug", OE_DEPLOY_ALIAS: "my-agent.vercel.app" }, scratch);
const neverFetch: ApiFetchLike = async () => {
  throw new Error("resolveVercelApi must not make a request");
};

check("resolveVercelApi: a team-scoped OE_VERCEL_API_TOKEN plus VERCEL_PROJECT_ID/ORG_ID is enough", () => {
  const api = resolveVercelApi({
    env: { OE_VERCEL_API_TOKEN: "team-token", VERCEL_PROJECT_ID: "prj_ci", VERCEL_ORG_ID: "team_ci" },
    deployEnv: API_ENV,
    cwd: "/repo",
    fetchImpl: neverFetch,
    readFile: () => undefined,
  });
  assert.equal(api.token, "team-token");
  assert.deepEqual(api.project, { idOrName: "prj_ci", teamSlug: "team-slug", teamId: "team_ci" });
  assert.equal(api.apiBase, undefined);
});

check("resolveVercelApi: no token STOPS, naming the variable and why nothing downstream can run", () => {
  assert.throws(
    () =>
      resolveVercelApi({
        env: { VERCEL_PROJECT_ID: "prj_ci" },
        deployEnv: API_ENV,
        cwd: "/repo",
        fetchImpl: neverFetch,
        homeDir: join(scratch, "no-such-home"),
        readFile: () => undefined,
      }),
    (err: unknown) =>
      err instanceof DeployConfigError &&
      /OE_VERCEL_API_TOKEN/.test((err as Error).message) &&
      /vercel login/.test((err as Error).message) &&
      /TEAM-SCOPED token is correct/.test((err as Error).message),
  );
});

check("resolveVercelApi: no resolvable project STOPS, naming every source", () => {
  assert.throws(
    () => resolveVercelApi({ env: { OE_VERCEL_API_TOKEN: "t" }, deployEnv: API_ENV, cwd: "/repo", fetchImpl: neverFetch, readFile: () => undefined }),
    (err: unknown) =>
      err instanceof DeployConfigError &&
      /OE_DEPLOY_PROJECT/.test((err as Error).message) &&
      /VERCEL_PROJECT_ID/.test((err as Error).message) &&
      /vercel link/.test((err as Error).message),
  );
});

check("resolveVercelApi: OE_VERCEL_API_BASE is carried onto the client", () => {
  const api = resolveVercelApi({
    env: { OE_VERCEL_API_TOKEN: "t", VERCEL_PROJECT_ID: "prj_ci", OE_VERCEL_API_BASE: "http://127.0.0.1:4000" },
    deployEnv: API_ENV,
    cwd: "/repo",
    fetchImpl: neverFetch,
    readFile: () => undefined,
  });
  assert.equal(api.apiBase, "http://127.0.0.1:4000");
});

await check("currentAliasTarget: a record with neither url nor id is `unresolved`, with a reason", async () => {
  const { api } = stubApi(() => ({ status: 200, body: {} }));
  const result = await currentAliasTarget(createVercelClient(api), ENV.alias);
  assert.equal(result.kind, "unresolved");
  assert.ok(result.kind === "unresolved" && /my-agent\.vercel\.app/.test(result.reason));
});

await check("currentAliasTarget: a THROWING client is `unresolved` and keeps the thrown reason", async () => {
  const { api } = stubApi(() => ({ status: 404, body: { error: { code: "not_found", message: "deployment not found" } } }));
  const result = await currentAliasTarget(createVercelClient(api), ENV.alias);
  assert.equal(result.kind, "unresolved");
  assert.ok(result.kind === "unresolved" && /deployment not found/.test(result.reason));
});

await check("currentAliasTarget: a real deployment record is `resolved`", async () => {
  const { api } = stubApi(() => ({ status: 200, body: RECORD_FIXTURE }));
  const result = await currentAliasTarget(createVercelClient(api), ENV.alias);
  assert.equal(result.kind, "resolved");
  assert.equal(result.kind === "resolved" && result.target.url, "https://my-agent-9f2h1kq0x.vercel.app");
});

check("unresolvedAliasFailure names every check that stops running, and the record only when recording", () => {
  const recording = unresolvedAliasFailure({ alias: "my-agent.vercel.app", reason: "HTTP 404", recording: true });
  assert.ok(/cron deploymentId check/.test(recording));
  assert.ok(/cron staleness check/.test(recording));
  assert.ok(/known-good pointer record/.test(recording));
  assert.ok(/no-op guard/.test(recording));
  assert.ok(/FATAL/.test(recording));

  const probeOnly = unresolvedAliasFailure({ alias: "my-agent.vercel.app", reason: "HTTP 404", recording: false });
  assert.equal(/known-good pointer record/.test(probeOnly), false);
  assert.ok(/cron deploymentId check/.test(probeOnly));
});

await check("runRollback: an unreadable alias says the no-op guard is OFF, and still rolls back", async () => {
  const vercel = fakeVercel({ unknownAlias: true });
  const store = memoryStore({ version: 1, lastGood: entry("https://my-agent-good.vercel.app", "t1"), history: [] });
  const lines: string[] = [];
  const result = await runRollback({ env: ENV, client: createVercelClient(vercel.api), store, log: (l) => lines.push(l) });
  assert.equal(result.ok, true);
  assert.ok(lines.some((l) => /no-op guard is OFF/.test(l)), "the disarmed guard must be announced, not vanish");
});

await check("runRecord: an unresolvable alias names the CALLING script and records nothing", async () => {
  const vercel = fakeVercel({ unknownAlias: true });
  const store = memoryStore();
  const lines: string[] = [];
  const result = await runRecord({
    env: ENV,
    client: createVercelClient(vercel.api),
    store,
    label: "deploy:verify --record",
    log: (l) => lines.push(l),
  });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /✗ deploy:verify --record:/.test(l)), "the ✗ line must name the script the operator ran");
  assert.ok(lines.some((l) => /npm run deploy:verify -- --url/.test(l)), "the remedy must be runnable on that script");
  assert.equal(store.current.lastGood, undefined);
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const verifyScript = join(repoRoot, "scripts", "deploy", "verify.ts");
const fakeHome = join(scratch, "fake-home");
const bareCwd = join(scratch, "bare-runner-cwd");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(bareCwd, { recursive: true });

const E2E_DEPLOYMENT_ID = "dpl_OPE1045E2E";
const E2E_DEPLOYMENT_HOST = "oe-1045-e2e-deployment.vercel.app";
const E2E_DEPLOYED_AT = 1_786_698_000_000;
const E2E_DEPLOYED_SHA = "c4460004c4460004c4460004c4460004c4460004";
const E2E_OTHER_HOST = "oe-1485-other-deployment.vercel.app";
const E2E_OTHER_SHA = "abcdef01abcdef01abcdef01abcdef01abcdef01";

type VerifyRun = { code: number | null; output: string };

function fakeStack(options: { aliasStatus?: number; omitCommitMeta?: boolean } = {}) {
  return createServer((req, res) => {
    const url = req.url ?? "";
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/control/v1/audit")) return send(200, {});
    if (url.startsWith("/v13/deployments/")) {
      if (options.aliasStatus && options.aliasStatus !== 200) return send(options.aliasStatus, { error: { code: "not_found", message: "deployment not found" } });
      const key = decodeURIComponent(url.slice("/v13/deployments/".length).split("?")[0]);
      if (key === E2E_OTHER_HOST) {
        return send(200, { id: "dpl_OPE1485OTHER", url: E2E_OTHER_HOST, readyState: "READY", createdAt: E2E_DEPLOYED_AT, meta: { githubCommitSha: E2E_OTHER_SHA } });
      }
      return send(200, {
        id: E2E_DEPLOYMENT_ID,
        url: E2E_DEPLOYMENT_HOST,
        readyState: "READY",
        createdAt: E2E_DEPLOYED_AT,
        ...(options.omitCommitMeta ? {} : { meta: { githubCommitSha: E2E_DEPLOYED_SHA } }),
      });
    }
    if (url.startsWith("/v9/projects/")) {
      return send(200, { crons: { deploymentId: E2E_DEPLOYMENT_ID, updatedAt: E2E_DEPLOYED_AT + 1_000 } });
    }
    if (url.startsWith("/v6/deployments")) return send(200, { deployments: [] });
    return send(404, { error: { code: "not_found", message: url } });
  });
}

async function runVerify(
  argv: string[],
  vars: Record<string, string>,
  options: { aliasStatus?: number; omitCommitMeta?: boolean; cwd?: string } = {},
): Promise<VerifyRun> {
  const server = fakeStack(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<VerifyRun>((resolve) => {
      const child = spawn(tsxBin, [verifyScript, ...argv, "--attempts", "1", "--delay-ms", "1"], {
        cwd: options.cwd ?? bareCwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fakeHome,
          NODE_NO_WARNINGS: "1",
          OE_DEPLOY_SCOPE: "team-slug",
          OE_DEPLOY_ALIAS: "oe-1045-e2e.invalid",
          OE_DEPLOY_BASE_URL: `http://127.0.0.1:${port}`,
          OE_DEPLOY_CONTROL_TOKEN: "oe-1045-not-a-real-token",
          OE_VERCEL_API_BASE: `http://127.0.0.1:${port}`,
          ...vars,
        },
      });
      let output = "";
      child.stdout.on("data", (c) => (output += String(c)));
      child.stderr.on("data", (c) => (output += String(c)));
      child.on("close", (code) => resolve({ code, output }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const CI_VARS = { OE_VERCEL_API_TOKEN: "oe-1045-team-scoped-token", VERCEL_PROJECT_ID: "prj_oe1045", VERCEL_ORG_ID: "team_oe1045" };

await check("deploy:verify --record COMPLETES on a token-only runner: no vercel login, no .vercel/", async () => {
  const pointer = join(scratch, "e2e-token-only.json");
  const run = await runVerify(["--record", "--no-rollback"], { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer });
  assert.equal(run.code, 0, `expected a clean exit on a token-only runner, got ${run.code}\n${run.output}`);
  assert.ok(/✓ deploy:verify: HTTP 200/.test(run.output), `the probe itself should have passed:\n${run.output}`);
  assert.ok(new RegExp(`crons.deploymentId \\(${E2E_DEPLOYMENT_ID}\\) matches`).test(run.output), `the cron check must run:\n${run.output}`);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(state.lastGood?.url, `https://${E2E_DEPLOYMENT_HOST}`);
  assert.equal(state.lastGood?.id, E2E_DEPLOYMENT_ID);
});

await check("deploy:verify EXITS NON-ZERO when it cannot resolve what the alias points at", async () => {
  const pointer = join(scratch, "e2e-unresolved.json");
  const run = await runVerify(["--record", "--no-rollback"], { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer }, { aliasStatus: 404 });
  assert.notEqual(run.code, 0, `deploy:verify must not exit 0 when the alias is unresolvable — got ${run.code}\n${run.output}`);
  assert.ok(/✓ deploy:verify: HTTP 200/.test(run.output), `the probe itself should have passed:\n${run.output}`);
  assert.ok(/cron deploymentId check/.test(run.output), "it must name the checks that stopped running");
  assert.ok(/known-good pointer record/.test(run.output));
  assert.equal(existsSync(pointer), false, "nothing may be recorded when the deployment is unknown");
});

await check("deploy:verify EXITS 2 with the variable NAME when no Vercel token can be found", async () => {
  const pointer = join(scratch, "e2e-no-token.json");
  const run = await runVerify(["--record", "--no-rollback"], { VERCEL_PROJECT_ID: "prj_oe1045", OE_DEPLOY_STATE_FILE: pointer });
  assert.equal(run.code, 2, `expected the config exit code, got ${run.code}\n${run.output}`);
  assert.ok(/OE_VERCEL_API_TOKEN/.test(run.output), `the missing variable must be named:\n${run.output}`);
  assert.equal(existsSync(pointer), false, "nothing may be recorded");
});

await check("deploy:verify EXITS 2 with the variable NAME when no project can be resolved", async () => {
  const run = await runVerify(["--record", "--no-rollback"], { OE_VERCEL_API_TOKEN: "oe-1045-team-scoped-token" });
  assert.equal(run.code, 2, `expected the config exit code, got ${run.code}\n${run.output}`);
  assert.ok(/VERCEL_PROJECT_ID/.test(run.output), `the missing variable must be named:\n${run.output}`);
});

const checkoutWithOwnHead = join(scratch, "checkout-with-own-head");
mkdirSync(checkoutWithOwnHead, { recursive: true });
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", checkoutWithOwnHead, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q");
git("-c", "user.name=OE Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "fixture");
const LOCAL_HEAD = git("rev-parse", "HEAD");

await check("deploy:verify --record stamps the DEPLOYMENT's own commit, not this checkout's HEAD", async () => {
  const pointer = join(scratch, "e2e-pointer-commit.json");
  const run = await runVerify(["--record", "--no-rollback"], { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer }, { cwd: checkoutWithOwnHead });
  assert.equal(run.code, 0, run.output);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(
    state.lastGood?.commit,
    E2E_DEPLOYED_SHA,
    `the pointer must carry the deployment's meta.githubCommitSha, not the local HEAD (${LOCAL_HEAD})\n${run.output}`,
  );
  assert.notEqual(LOCAL_HEAD, E2E_DEPLOYED_SHA, "the fixture checkout must sit on a different sha, or this leg proves nothing");
  assert.ok(/pointer commit ← the deployment's own meta.githubCommitSha/.test(run.output), `the run must say where the commit came from:\n${run.output}`);
});

await check("deploy:verify --record falls back to the local HEAD when the deployment record carries no commit sha", async () => {
  const pointer = join(scratch, "e2e-pointer-commit-fallback.json");
  const run = await runVerify(
    ["--record", "--no-rollback"],
    { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer },
    { cwd: checkoutWithOwnHead, omitCommitMeta: true },
  );
  assert.equal(run.code, 0, run.output);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(state.lastGood?.commit, LOCAL_HEAD, `expected the local HEAD fallback\n${run.output}`);
  assert.ok(/pointer commit ← this checkout's git HEAD/.test(run.output), `the fallback must say so out loud:\n${run.output}`);
});

await check("deploy:verify --record: an explicit --commit outranks the deployment's own sha", async () => {
  const pointer = join(scratch, "e2e-pointer-commit-explicit.json");
  const run = await runVerify(
    ["--record", "--no-rollback", "--commit", "0f0f0f0"],
    { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer },
    { cwd: checkoutWithOwnHead },
  );
  assert.equal(run.code, 0, run.output);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(state.lastGood?.commit, "0f0f0f0", `the operator's own --commit must win\n${run.output}`);
});

await check("deploy:verify --record --url <other deployment> stamps THAT deployment's sha, not the alias's", async () => {
  const pointer = join(scratch, "e2e-pointer-commit-url.json");
  const run = await runVerify(
    ["--record", "--no-rollback", "--url", `https://${E2E_OTHER_HOST}`],
    { ...CI_VARS, OE_DEPLOY_STATE_FILE: pointer },
    { cwd: checkoutWithOwnHead },
  );
  assert.equal(run.code, 0, run.output);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(state.lastGood?.url, `https://${E2E_OTHER_HOST}`);
  assert.equal(
    state.lastGood?.commit,
    E2E_OTHER_SHA,
    `the pointer must carry the sha of the deployment named on --url, not the alias target's (${E2E_DEPLOYED_SHA}) or the local HEAD (${LOCAL_HEAD})\n${run.output}`,
  );
  assert.equal(
    state.lastGood?.id,
    undefined,
    `--url with no --id must record NO id, not the alias target's (${E2E_DEPLOYMENT_ID})\n${run.output}`,
  );
});

await check("deploy:verify honours --url/--id, so its own printed remedy works", async () => {
  const pointer = join(scratch, "e2e-explicit.json");
  const run = await runVerify(["--record", "--no-rollback", "--url", "https://oe-1045-explicit.vercel.app", "--id", "dpl_OPE1045EXPLICIT"], {
    ...CI_VARS,
    OE_DEPLOY_STATE_FILE: pointer,
  });
  assert.equal(run.code, 0, run.output);
  const state = JSON.parse(readFileSync(pointer, "utf8")) as DeployState;
  assert.equal(state.lastGood?.url, "https://oe-1045-explicit.vercel.app");
  assert.equal(state.lastGood?.id, "dpl_OPE1045EXPLICIT");
});

rmSync(scratch, { recursive: true, force: true });
console.log(
  `✓ deploy: ${checks} check(s) passed (rollback selection, pointer, probe→decision, cron registration, REST client + credential resolution, verify exit codes, env validation — all offline)`,
);
