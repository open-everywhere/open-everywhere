import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import type { Provider } from "../agent/access/providers.js";
import type { PrFetchFn } from "../agent/scm/pr.js";

const dir = join(tmpdir(), `open-everywhere-binding-pr-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_CREDENTIAL_BINDING_LIVE;

const { stageCredentialBindingPr } = await import("../agent/credentials/binding-pr.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { stringifyCredentialBindings, applyBindingOverride, emptyCredentialBindingsFile } = await import("../agent/access/credential-bindings-codemod.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejectsWith(fn: () => Promise<unknown>, fragment: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not reject)`);
}

const validProviders: Provider[] = [
  {
    name: "acme",
    connection: "acme",
    allows: ["api-key"],
    credentials: [{ id: "key", type: "api-key", secretRef: "ACME_API_KEY", broker: "env" }],
  },
];
const loadValid = () => validProviders;
const loadInvalid = (): readonly Provider[] => [{ name: "acme", connection: "acme", allows: [], credentials: [] }];

function cfg(over: Partial<AccessRequestsConfig> = {}): AccessRequestsConfig {
  return {
    configRepo: "acme/config",
    configBase: "main",
    baseBundles: () => [],
    baseBindings: () => [],
    baseProviders: loadValid,
    ...over,
  };
}

const WHERE = { org: "default", platform: "slack", workspace: "T1", surface: "C1" } as const;
const FAKE_SECRET = "oe-fake-secret-NEVER-IN-A-DIFF-9f3a";
const baseArgs = {
  provider: "acme",
  credential: "key",
  storedRef: "db:acme:key",
  credentialAuditId: "intake-abc123",
  requestedBy: "U_ADMIN",
  where: WHERE,
};

async function rowsFor(action: string, credentialAuditId: string) {
  const all = await readAudit({ org: "default", limit: 50 });
  return all.filter((a) => a.action === action && (a.detail as { credentialAuditId?: unknown } | undefined)?.credentialAuditId === credentialAuditId);
}

{
  const res = await stageCredentialBindingPr(baseArgs, { config: { baseBundles: () => [], baseBindings: () => [] } as AccessRequestsConfig });
  ok(res.staged === false && !!res.skipped && res.skipped.includes("config repo not configured"), "skip: unconfigured config repo → fail-safe skip");
}
{
  const res = await stageCredentialBindingPr(baseArgs, { config: cfg({ baseProviders: undefined }) });
  ok(res.staged === false && !!res.skipped && res.skipped.includes("base providers not registered"), "skip: absent base providers → fail-safe skip");
}

{
  let touched = false;
  const contents = {
    getFile: async () => {
      touched = true;
      return null;
    },
    putFile: async () => {
      touched = true;
      return "sha";
    },
  };
  const res = await stageCredentialBindingPr({ ...baseArgs, credentialAuditId: "intake-dry" }, { config: cfg(), dryRun: true, contents });
  ok(res.staged === true && res.dryRun === true && res.url === undefined, "dry-run: staged, no url");
  ok(touched === false, "dry-run: no GitHub network (getFile/putFile never called)");
  const proposed = await rowsFor("credential.binding_proposed", "intake-dry");
  ok(proposed.length === 1, "dry-run: one binding_proposed audit row");
  const d = proposed[0].detail as Record<string, unknown>;
  ok(d.dryRun === true && d.provider === "acme" && d.credential === "key" && d.storedRef === "db:acme:key" && d.broker === "db", "dry-run: audit carries references (provider/credential/ref/broker), dryRun:true");
  ok((await rowsFor("credential.binding_opened", "intake-dry")).length === 0, "dry-run: NO binding_opened row");
}

{
  const state = { puts: 0, prPosts: 0 };
  const contents = {
    getFile: async () => null,
    putFile: async () => {
      state.puts++;
      return "sha";
    },
  };
  const prFetch: PrFetchFn = async () => {
    state.prPosts++;
    return { ok: true, status: 201, text: async () => "", json: async () => ({ html_url: "x", number: 1 }) };
  };
  await rejectsWith(
    () =>
      stageCredentialBindingPr(baseArgs, {
        config: cfg({ baseProviders: loadInvalid }),
        dryRun: false,
        contents,
        getBranchSha: async () => "base-sha",
        createBranch: async () => "created" as const,
        prFetch,
        resolveToken: async () => "tok",
      }),
    "empty credential allowlist",
    "ring ②: an invalid merged provider set refuses",
  );
  ok(state.puts === 0 && state.prPosts === 0, "ring ②: nothing committed, no PR opened when merged validation fails");
}

interface FakeGh {
  branches: Record<string, string>;
  files: Record<string, { content: string; sha: string }>;
  puts: string[];
  prPost: { title: string; body: string; head: string; base: string }[];
  prState: "new" | "open-exists" | "closed-exists";
  patched: { number: number; body: string }[];
}
function fakeGh(prState: FakeGh["prState"]): FakeGh {
  return { branches: { main: "base-sha" }, files: {}, puts: [], prPost: [], prState, patched: [] };
}
function ghDeps(state: FakeGh) {
  const contents = {
    getFile: async (_repo: string, path: string, branch: string) => state.files[`${branch}:${path}`] ?? null,
    putFile: async (_repo: string, path: string, content: string, _msg: string, branch: string) => {
      state.files[`${branch}:${path}`] = { content, sha: `sha-${state.puts.length + 1}` };
      state.puts.push(content);
      return "commit-sha";
    },
  };
  const prFetch: PrFetchFn = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/pulls")) {
      if (state.prState === "new") {
        const b = JSON.parse(init.body!) as { title: string; body: string; head: string; base: string };
        state.prPost.push(b);
        return { ok: true, status: 201, text: async () => "", json: async () => ({ html_url: "https://github.com/acme/config/pull/11", number: 11 }) };
      }
      const b = JSON.parse(init.body!) as { title: string; body: string; head: string; base: string };
      state.prPost.push(b);
      return { ok: false, status: 422, text: async () => "A pull request already exists for acme:...", json: async () => ({}) };
    }
    if (init.method === "GET" && url.includes("/pulls?head=")) {
      const st = state.prState === "closed-exists" ? "closed" : "open";
      return { ok: true, status: 200, text: async () => "", json: async () => [{ html_url: "https://github.com/acme/config/pull/11", number: 11, state: st }] };
    }
    if (init.method === "PATCH" && /\/pulls\/\d+$/.test(url)) {
      const b = JSON.parse(init.body!) as { state: string; body: string };
      state.patched.push({ number: 11, body: b.body });
      return { ok: true, status: 200, text: async () => "", json: async () => ({ html_url: "https://github.com/acme/config/pull/11", number: 11 }) };
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };
  return {
    config: cfg(),
    baseProviders: loadValid,
    dryRun: false,
    resolveToken: async () => "tok",
    getBranchSha: async ({ branch }: { branch: string }) => state.branches[branch] ?? null,
    createBranch: async ({ branch, sha }: { branch: string; sha: string }) => {
      state.branches[branch] = sha;
      return "created" as const;
    },
    contents,
    prFetch,
    committer: { name: "bot", email: "bot@x" },
  };
}

{
  const state = fakeGh("new");
  const res = await stageCredentialBindingPr({ ...baseArgs, credentialAuditId: "intake-live" }, ghDeps(state));
  const branch = "credential-binding/acme-key";
  ok(res.staged && !res.dryRun && res.url === "https://github.com/acme/config/pull/11", "live: opened PR, url returned");
  ok(state.branches[branch] === "base-sha", "live: deterministic branch cut from base");
  ok(state.puts.length === 1, "live: exactly one overlay commit");
  const expectedBytes = stringifyCredentialBindings(applyBindingOverride(emptyCredentialBindingsFile(), { provider: "acme", credential: "key", broker: "db", secretRef: "db:acme:key" }).file);
  ok(state.puts[0] === expectedBytes, "live: committed bytes are EXACTLY the deterministic codemod output");
  ok(state.prPost.length === 1 && state.prPost[0].head === branch && state.prPost[0].base === "main", "live: PR opened head→base");
  ok(state.prPost[0].title.includes("acme/key"), "live: PR title names the credential");
  const body = state.prPost[0].body;
  ok(body.includes("db:acme:key") && body.includes("intake-live") && body.includes("Merging this PR IS the approval"), "live: PR body carries the ref, the CITED credential.stored id, and the merge-is-the-gate doctrine");
  ok(body.includes("OTHER consumers"), "live: PR body carries the cross-consumer warning");
  ok(!body.includes(FAKE_SECRET), "live: PR body carries NO secret value");
  const proposed = await rowsFor("credential.binding_proposed", "intake-live");
  const opened = await rowsFor("credential.binding_opened", "intake-live");
  ok(proposed.length === 1 && opened.length === 1, "live: both binding_proposed + binding_opened audited");
  const od = opened[0].detail as Record<string, unknown>;
  ok(od.pr === 11 && od.updated === false && od.reopened === false && od.storedRef === "db:acme:key", "live: binding_opened references pr/url/updated/reopened + ref (no value)");
  const allRows = await readAudit({ org: "default", limit: 50 });
  ok(!allRows.some((r) => JSON.stringify(r.detail).includes(FAKE_SECRET)), "leak-proof: the fake secret appears in NO audit row");
}

{
  const state = fakeGh("open-exists");
  const branch = "credential-binding/acme-key";
  state.branches[branch] = "base-sha";
  state.files[`${branch}:agent/access/credential-bindings.json`] = {
    content: stringifyCredentialBindings(applyBindingOverride(emptyCredentialBindingsFile(), { provider: "acme", credential: "key", broker: "db", secretRef: "db:acme:key" }).file),
    sha: "existing",
  };
  const res = await stageCredentialBindingPr({ ...baseArgs, credentialAuditId: "intake-open" }, ghDeps(state));
  ok(res.url === "https://github.com/acme/config/pull/11", "re-paste(open): same PR url");
  ok(state.puts.length === 0, "re-paste(open): idempotent — NO second overlay commit");
  const opened = await rowsFor("credential.binding_opened", "intake-open");
  ok(opened.length === 1 && (opened[0].detail as Record<string, unknown>).updated === true && (opened[0].detail as Record<string, unknown>).reopened === false, "re-paste(open): binding_opened updated:true, reopened:false");
}

{
  const state = fakeGh("closed-exists");
  const res = await stageCredentialBindingPr({ ...baseArgs, credentialAuditId: "intake-closed" }, ghDeps(state));
  ok(res.url === "https://github.com/acme/config/pull/11", "re-paste(closed): PR url returned");
  ok(state.patched.length === 1 && state.patched[0].number === 11, "re-paste(closed): the closed PR was PATCHed (reopened), not dead-ended");
  ok(state.patched[0].body.includes("db:acme:key"), "re-paste(closed): reopen refreshes the body (references only)");
  const opened = await rowsFor("credential.binding_opened", "intake-closed");
  ok(opened.length === 1 && (opened[0].detail as Record<string, unknown>).reopened === true, "re-paste(closed): binding_opened reopened:true");
}

assert.ok(passed > 0);
console.log(`✓ binding-pr: ${passed} assertions passed`);
