process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { principalIdOf } from "../agent/access/request.js";
import { listRoutines } from "../agent/routines/store.js";
import { fetchPullRequestStatus, describePrStatus, prIsSettled, type PrStatusSnapshot } from "../agent/scm/pr-status.js";
import checkPrStatusTool from "../agent/tools/check_pr_status.js";
import subscribePrTool, { subscribePrPrompt, DEFAULT_CHECK_INTERVAL_MINUTES, MIN_CHECK_INTERVAL_MINUTES } from "../agent/tools/subscribe_pr.js";
import type { PrFetchFn } from "../agent/scm/pr.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/web"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "eng", channels: ["slack/T1/C1"], memory: "eng" })],
  loadSilos: () => [{ name: "eng", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === "C1" ? ["eng"] : []),
});
process.env.GITHUB_TOKEN = "test-pat";

const ctx = (attrOver: Record<string, unknown> = {}): BindableContext =>
  ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", ...attrOver }, principalId: "U1", principalType: "slack-user" } } },
  }) as unknown as BindableContext;

const routineCtx = (): BindableContext =>
  ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" } } } },
  }) as unknown as BindableContext;

{
  const mkFetch = (body: Record<string, unknown>): { fn: PrFetchFn; seen: { url: string; method: string; headers: Record<string, string> }[] } => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fn: PrFetchFn = async (url, init) => {
      seen.push({ url, method: init.method, headers: init.headers });
      return { ok: true, status: 200, text: async () => "", json: async () => body };
    };
    return { fn, seen };
  };

  const { fn, seen } = mkFetch({
    html_url: "https://github.com/acme/web/pull/42",
    title: "Add widget",
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-07-08T10:00:00Z",
  });
  const status = await fetchPullRequestStatus({ repo: "acme/web", number: 42, token: "ghs_x", fetchFn: fn });
  ok(seen[0].url.endsWith("/repos/acme/web/pulls/42") && seen[0].method === "GET", "fetchPullRequestStatus GETs the single-PR endpoint");
  ok(seen[0].headers.authorization === "Bearer ghs_x", "fetchPullRequestStatus sends the token as Bearer");
  ok(status.url === "https://github.com/acme/web/pull/42" && status.title === "Add widget" && status.state === "open" && !status.merged && !status.draft, "fetchPullRequestStatus parses the snapshot fields");
  ok(!prIsSettled(status), "an open, unmerged PR is NOT settled");

  const merged: PrStatusSnapshot = { ...status, merged: true };
  ok(prIsSettled(merged), "a merged PR is settled");
  const closed: PrStatusSnapshot = { ...status, state: "closed" };
  ok(prIsSettled(closed), "a closed (not merged) PR is settled too");

  ok(describePrStatus(status) === 'OPEN — "Add widget" (updated 2026-07-08T10:00:00Z) https://github.com/acme/web/pull/42', "describePrStatus formats an open PR");
  ok(describePrStatus(merged).startsWith("MERGED"), "describePrStatus labels a merged PR");
  ok(describePrStatus(closed).startsWith("CLOSED (not merged)"), "describePrStatus labels a closed-not-merged PR");
  ok(describePrStatus({ ...status, draft: true }).startsWith("OPEN (draft)"), "describePrStatus labels a draft PR");

  const boom: PrFetchFn = async () => ({ ok: false, status: 404, text: async () => "not found", json: async () => ({}) });
  await assert.rejects(fetchPullRequestStatus({ repo: "acme/web", number: 9, token: "x", fetchFn: boom }), /404 not found/);
  n++;
}

{
  const prompt = subscribePrPrompt({ repo: "acme/web", number: 42, url: "https://github.com/acme/web/pull/42", baseline: "OPEN — test", intervalMinutes: 15 });
  ok(prompt.includes("PR #42 in acme/web"), "prompt names the repo + PR number");
  ok(prompt.includes("Last known status: OPEN — test"), "prompt embeds the baseline");
  ok(prompt.includes("subscribe_pr"), "prompt instructs re-arming via subscribe_pr itself");
  ok(!prompt.includes("create_routine"), "prompt does NOT delegate the re-arm to the gated create_routine");
  ok(prompt.includes("MERGED or CLOSED") && prompt.includes("STOP"), "prompt instructs stopping on a terminal state");
  ok(prompt.includes("checkIntervalMinutes=15"), "prompt passes the interval back into subscribe_pr");
  ok(prompt.includes('repo="acme/web"') && prompt.includes("number=42"), "prompt repeats the exact repo/number so the re-armed check targets the same PR");
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    ok(url.includes("/repos/acme/web/pulls/42"), "check_pr_status tool hits the single-PR endpoint");
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ html_url: "https://github.com/acme/web/pull/42", title: "Add widget", state: "open", merged: false, draft: false, updated_at: "2026-07-08T10:00:00Z" }),
    };
  }) as typeof fetch;

  const res = (await checkPrStatusTool.execute({ repo: "acme/web", number: 42 }, ctx() as never)) as { state: string; summary: string };
  ok(res.state === "open" && res.summary.startsWith("OPEN"), "check_pr_status: returns the live status via the GITHUB_TOKEN PAT fallback");

  await assert.rejects(
    async () => { await checkPrStatusTool.execute({ repo: "acme/ungranted", number: 1 }, ctx() as never); },
    /not granted/,
    "check_pr_status: refuses a repo not in the granted set",
  );
  n++;

  globalThis.fetch = originalFetch;
}

{
  const originalFetch = globalThis.fetch;
  let prJson: Record<string, unknown> = {
    html_url: "https://github.com/acme/web/pull/42",
    title: "Add widget",
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-07-08T10:00:00Z",
  };
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => "", json: async () => prJson })) as unknown as typeof fetch;

  const p = resolvePartition(ctx());
  ok((await listRoutines(p)).length === 0, "subscribe_pr: no routines exist yet on this surface");

  const res = (await subscribePrTool.execute({ repo: "acme/web", number: 42 }, ctx() as never)) as {
    subscribed: boolean;
    routineId?: string;
    status: string;
    nextCheckAt?: string;
  };
  ok(res.subscribed === true && !!res.routineId, "subscribe_pr: subscribing to an open PR creates a routine");
  ok(res.status.startsWith("OPEN"), "subscribe_pr: reports the initial status");
  ok(res.nextCheckAt !== undefined, "subscribe_pr: reports when the first check fires");

  const routines = await listRoutines(p);
  ok(routines.length === 1, "subscribe_pr: exactly one routine persisted");
  const r = routines[0];
  ok(r.trigger.kind === "once", "subscribe_pr: the trigger is a one-shot (`once`)");
  ok(r.nextRunAt === (r.trigger as { at: string }).at, "subscribe_pr: nextRunAt matches the trigger's `at`");
  const dueMs = Date.parse(r.nextRunAt!) - Date.now();
  ok(dueMs > (DEFAULT_CHECK_INTERVAL_MINUTES - 1) * 60_000 && dueMs <= DEFAULT_CHECK_INTERVAL_MINUTES * 60_000 + 5_000, "subscribe_pr: defaults to a ~15 minute first check");
  ok(r.prompt.includes("PR #42 in acme/web") && r.prompt.includes("Last known status: OPEN"), "subscribe_pr: the stored routine's prompt carries the re-arm instruction + baseline");

  const res2 = (await subscribePrTool.execute({ repo: "acme/web", number: 43, checkIntervalMinutes: MIN_CHECK_INTERVAL_MINUTES }, ctx() as never)) as { subscribed: boolean };
  ok(res2.subscribed === true, "subscribe_pr: accepts a custom (min-bound) interval");
  ok((await listRoutines(p)).length === 2, "subscribe_pr: a second subscription adds a second routine");

  await assert.rejects(
    async () => { await subscribePrTool.execute({ repo: "acme/ungranted", number: 1 }, ctx() as never); },
    /not granted/,
    "subscribe_pr: refuses a repo not in the granted set",
  );
  n++;

  await assert.rejects(
    async () => { await subscribePrTool.execute({ repo: "acme/web", number: 42 }, ctx({ channel_type: "mpim" }) as never); },
    /Group DMs are execution-only/,
    "subscribe_pr: refuses from a group DM",
  );
  n++;

  prJson = { ...prJson, merged: true, state: "closed" };
  const res3 = (await subscribePrTool.execute({ repo: "acme/web", number: 42 }, ctx() as never)) as { subscribed: boolean; status: string; routineId?: string };
  ok(res3.subscribed === false && res3.routineId === undefined, "subscribe_pr: an already-merged PR is NOT subscribed");
  ok(res3.status.includes("already settled"), "subscribe_pr: reports why nothing was created");
  ok((await listRoutines(p)).length === 2, "subscribe_pr: the settled-PR call added no new routine");

  globalThis.fetch = originalFetch;
}

{
  const originalFetch = globalThis.fetch;
  let prJson: Record<string, unknown> = {
    html_url: "https://github.com/acme/web/pull/77",
    title: "Refactor the widget",
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-07-09T09:00:00Z",
  };
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => "", json: async () => prJson })) as unknown as typeof fetch;

  const rctx = routineCtx();
  ok(principalIdOf(rctx) === undefined, "regression: a routine-fired ctx resolves NO principal (matches dispatch.ts)");

  const p = resolvePartition(rctx);
  const before = (await listRoutines(p)).length;

  const res = (await subscribePrTool.execute({ repo: "acme/web", number: 77 }, rctx as never)) as { subscribed: boolean; routineId?: string };
  ok(res.subscribed === true && !!res.routineId, "regression: subscribe_pr arms the next check with no principal — the re-arm path WORKS");

  const after = await listRoutines(p);
  ok(after.length === before + 1, "regression: exactly one new routine was armed by the principal-less re-arm");
  const armed = after.find((r) => r.id === res.routineId)!;
  ok(armed.trigger.kind === "once", "regression: the re-armed routine is a one-shot (`once`)");
  ok(armed.createdBy === undefined, "regression: no creator stamped on a principal-less re-arm (routines are surface-owned)");
  ok(armed.prompt.includes("PR #77 in acme/web") && armed.prompt.includes("Last known status: OPEN"), "regression: the re-armed prompt is code-templated with the fresh baseline");
  ok(armed.prompt.includes("subscribe_pr") && !armed.prompt.includes("create_routine"), "regression: the re-armed prompt loops through subscribe_pr, never the gated create_routine");

  prJson = { ...prJson, merged: true, state: "closed" };
  const settledBefore = (await listRoutines(p)).length;
  const res2 = (await subscribePrTool.execute({ repo: "acme/web", number: 77 }, rctx as never)) as { subscribed: boolean; routineId?: string };
  ok(res2.subscribed === false && res2.routineId === undefined, "regression: a settled PR arms nothing on a fired turn (chain self-terminates)");
  ok((await listRoutines(p)).length === settledBefore, "regression: no routine added for a settled PR");

  globalThis.fetch = originalFetch;
}

console.log(`\n✓ pr-subscribe: ${n} assertions passed (status fetch, re-arm prompt, check_pr_status + subscribe_pr tools, once-routine persistence, settled short-circuit)\n`);
