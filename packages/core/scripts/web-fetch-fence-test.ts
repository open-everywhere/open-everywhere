import assert from "node:assert/strict";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("web-fetch-fence");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

_setDeploymentIdentityForTest({ org: "acme-org", workspace: "ws1", surface: "c1" });

await import("./_register-test-config.js");

const { assertEgressReach, egressReachDenial, EGRESS_REPORT_PROTOCOL, hostReachable, MAX_REDIRECT_HOPS, redirectBoundDenial } = await import(
  "../agent/access/host-egress.js"
);
const { withEgressFence, HOP_HOOK_ABSENT } = await import("../agent/access/web-fetch-fence.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const { formatWindowToken, taskWindowId } = await import("../agent/channels/window-key.js");
const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");

type ReachableHost = import("../agent/access/resolver.js").ReachableHost;
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type ToolDefinition = import("eve/tools").ToolDefinition;
type ToolContext = import("eve/tools").ToolContext;
type OperationalStore = import("../agent/operational/store.js").OperationalStore;

const CTX = {} as BindableContext;
const hostsOf =
  (hosts: readonly ReachableHost[]) =>
  (): readonly ReachableHost[] =>
    hosts;
const passThrough = async (_c: BindableContext, ids: readonly string[]) => ids;

function spyTool(): ToolDefinition & { calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name: "web_fetch",
    description: "fetch",
    inputSchema: { type: "object", properties: {} },
    execute: async (input: unknown) => {
      calls.push(input);
      return { content: "ok", contentType: "text/plain", truncated: false, url: (input as { url: string }).url };
    },
  } as unknown as ToolDefinition & { calls: unknown[] };
  tool.calls = calls;
  return tool;
}

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await Promise.resolve(fn());
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal, got none");
}

{
  const allow = hostsOf([{ host: "docs.acme.test", viaConnection: null }]);

  const url = await assertEgressReach(CTX, "https://docs.acme.test/a/b?q=1", { tool: "web_fetch", hosts: allow, narrow: passThrough });
  ok(url.hostname === "docs.acme.test", "an allow-listed host clears the reach decision and the parsed URL comes back");

  const upper = await assertEgressReach(CTX, "https://DOCS.acme.TEST/x", { tool: "web_fetch", hosts: allow, narrow: passThrough });
  ok(upper.hostname === "docs.acme.test", "host matching is case-insensitive (a upper-cased hostname is the same host)");
  ok(hostReachable("DOCS.acme.test", allow()) && !hostReachable("evil.test", allow()), "hostReachable is the boolean face of the same EXACT-match rule");

  const denied = await refusal(() => assertEgressReach(CTX, "https://evil.test/steal", { tool: "web_fetch", hosts: allow, narrow: passThrough }));
  ok(denied.startsWith("web_fetch:"), "the refusal is prefixed with the TOOL that was refused, not with another tool's name");
  ok(denied.includes('"evil.test"'), "🔴 the refusal NAMES the host that was denied");
  ok(denied.includes("egress allow-list"), "🔴 …and says WHY: the egress allow-list, not a transport failure");
  ok(denied.includes("policy, not an outage"), "…says the deny is policy, so the model does not retry it");
  ok(denied.includes(EGRESS_REPORT_PROTOCOL), "🔴 …and carries the SHARED report/widening protocol verbatim — one phrasing across the sandbox README and this fence, not two");
  ok(denied.includes("reviewed pull request"), "…which points at the actual widening route (a reviewed PR against the granting bundle)");
  ok(denied === egressReachDenial("web_fetch", "evil.test", "not-allowlisted"), "the thrown text IS the exported refusal builder's output (one copy)");

  const star = hostsOf([{ host: "*", viaConnection: null }, { host: "*.acme.test", viaConnection: null }]);
  ok(
    (await refusal(() => assertEgressReach(CTX, "https://evil.test/x", { tool: "web_fetch", hosts: star, narrow: passThrough }))).includes("evil.test"),
    "🔴 a `*` wildcard in the allow-list does NOT widen the host-side plane (exact-match only, fail-closed)",
  );

  const meta = await refusal(() => assertEgressReach(CTX, "http://169.254.169.254/latest/meta-data/", { tool: "web_fetch", hosts: allow, narrow: passThrough }));
  ok(meta.startsWith("web_fetch: refusing to fetch an internal/loopback/link-local host"), "a literal metadata IP is refused before any allow-list read, prefixed with the calling tool");
  const scheme = await refusal(() => assertEgressReach(CTX, "file:///etc/passwd", { tool: "web_fetch", hosts: allow, narrow: passThrough }));
  ok(scheme.startsWith("web_fetch: only http(s) URLs"), "a non-http(s) scheme is refused (eve's https-only rule is not weakened, only doubled)");
}

{
  const allow = hostsOf([{ host: "docs.acme.test", viaConnection: null }]);

  const okTool = spyTool();
  const fencedOk = withEgressFence("web_fetch", okTool, { hosts: allow, narrow: passThrough });
  const out = (await fencedOk.execute({ url: "https://docs.acme.test/page", format: "markdown" }, {} as ToolContext)) as { url: string };
  ok(okTool.calls.length === 1, "an allow-listed fetch reaches the framework's own execute — the fence is ADDITIVE, it does not replace the dispatch");
  ok(JSON.stringify(okTool.calls[0]) === JSON.stringify({ url: "https://docs.acme.test/page", format: "markdown" }), "…with the input passed through byte-identically (format and all)");
  ok(out.url === "https://docs.acme.test/page", "…and the framework's result comes back unchanged");

  const denyTool = spyTool();
  const fencedDeny = withEgressFence("web_fetch", denyTool, { hosts: allow, narrow: passThrough });
  const msg = await refusal(() => fencedDeny.execute({ url: "https://evil.test/steal" }, {} as ToolContext));
  ok(msg.includes('"evil.test"'), "a denied fetch throws the legible refusal naming the host");
  ok(denyTool.calls.length === 0, "🔴 …and the wrapped execute is NEVER reached — the deny happens BEFORE the request is made, not after");

  const shapeOf = (t: ToolDefinition) => JSON.stringify({ ...(t as unknown as Record<string, unknown>), execute: undefined });
  ok(shapeOf(fencedOk) === shapeOf(okTool), "the wrap preserves every other field (name/description/inputSchema/projection) — only execute is replaced");

  for (const bad of [{}, { url: 42 }, { url: "   " }, null]) {
    const t = spyTool();
    const f = withEgressFence("web_fetch", t, { hosts: allow, narrow: passThrough });
    const m = await refusal(() => f.execute(bad, {} as ToolContext));
    ok(m.includes("no `url` to check"), `an unreadable destination (${JSON.stringify(bad)}) is REFUSED, not passed through`);
    ok(t.calls.length === 0, `…and does not dispatch (${JSON.stringify(bad)})`);
  }
}

{
  const t = spyTool();
  const fenced = withEgressFence("web_fetch", t, {});
  await fenced.execute({ url: "https://raw.githubusercontent.com/o/r/main/README.md" }, {} as ToolContext);
  ok(t.calls.length === 1, "🔴 with NO injected list, the fence resolves the LIVE session access and allows the bundle's granted host");

  const t2 = spyTool();
  const fenced2 = withEgressFence("web_fetch", t2, {});
  const m = await refusal(() => fenced2.execute({ url: "https://api.github.com/user" }, {} as ToolContext));
  ok(m.includes('"api.github.com"') && t2.calls.length === 0, "🔴 …and denies a host the SAME config does not grant — a near-miss sibling of the granted one, so this cannot pass by accident");
}

{
  const credentialed = hostsOf([
    { host: "api.acme.test", viaConnection: "acme-conn" },
    { host: "still.acme.test", viaConnection: "other-conn" },
    { host: "docs.acme.test", viaConnection: null },
  ]);

  const revoked = await refusal(() =>
    assertEgressReach(CTX, "https://api.acme.test/x", { tool: "web_fetch", hosts: credentialed, narrow: async (_c, ids) => ids.filter((i) => i !== "acme-conn") }),
  );
  ok(revoked.includes("revoked") && revoked.includes("revoke_connector"), "🔴 a host reachable only via a REVOKED connection is denied, and the refusal says the revoke is why");
  ok(revoked.includes(EGRESS_REPORT_PROTOCOL), "…still carrying the one shared report protocol");

  const sibling = await assertEgressReach(CTX, "https://still.acme.test/x", { tool: "web_fetch", hosts: credentialed, narrow: async (_c, ids) => ids.filter((i) => i !== "acme-conn") });
  ok(sibling.hostname === "still.acme.test", "a sibling credentialed host that was NOT revoked stays reachable (narrow-only, never a blanket deny)");

  const broken = await refusal(() => assertEgressReach(CTX, "https://api.acme.test/x", { tool: "web_fetch", hosts: credentialed, narrow: async () => null }));
  ok(broken.includes("revoked"), "🔴 an UNREADABLE override store denies the credentialed host — never read as 'nothing was revoked'");

  let lookups = 0;
  await assertEgressReach(CTX, "https://docs.acme.test/x", {
    tool: "web_fetch",
    hosts: credentialed,
    narrow: async (_c, ids) => {
      lookups++;
      return ids;
    },
  });
  ok(lookups === 0, "a credential-less host carries no connector identity to narrow, so the override lookup is skipped entirely");

  {
    const { narrowByConnectorOverride } = await import("../agent/access/connector-scope.js");
    const live = getOperationalStore();
    const fake = {
      ...live,
      connectorOverrides: async (org: string, scopeKey: string) =>
        org === "acme-org" && scopeKey === "local/ws1/c1" ? [{ connector: "acme-conn", granted: false }] : [],
    } as OperationalStore;
    registerOperationalStore(fake);
    resetOperationalStore();
    try {
      const t = spyTool();
      const fenced = withEgressFence("web_fetch", t, { hosts: credentialed, narrow: narrowByConnectorOverride });
      const m = await refusal(() => fenced.execute({ url: "https://api.acme.test/x" }, {} as ToolContext));
      ok(m.includes("revoked") && t.calls.length === 0, "🔴 END TO END: a real connector_override row closes web_fetch's reach to the revoked host, on the session's next turn and with no deploy");
      const t2 = spyTool();
      await withEgressFence("web_fetch", t2, { hosts: credentialed, narrow: narrowByConnectorOverride }).execute({ url: "https://still.acme.test/x" }, {} as ToolContext);
      ok(t2.calls.length === 1, "…while the connection the same row did NOT revoke still fetches");
    } finally {
      registerOperationalStore(live);
      resetOperationalStore();
    }
  }
}

{
  const live = getOperationalStore();
  const rows: { action: string; detail?: Record<string, unknown> }[] = [];
  const fake = { ...live, appendAudit: async (r: { action: string; detail?: Record<string, unknown> }) => void rows.push(r) } as unknown as OperationalStore;
  registerOperationalStore(fake);
  resetOperationalStore();
  try {
    const allow = hostsOf([{ host: "docs.acme.test", viaConnection: null }]);
    await refusal(() => assertEgressReach(CTX, "https://evil.test/steal", { tool: "web_fetch", hosts: allow, narrow: passThrough }));
    const deny = rows.find((r) => r.action === "egress.hostside.deny");
    ok(deny !== undefined, "🔴 a host-side reach deny writes an `egress.hostside.deny` audit row");
    ok(deny?.detail?.host === "evil.test", "…carrying the DESTINATION host (the thing worth asking about later)");
    ok(deny?.detail?.reason === "not-allowlisted", "…and the reason it was refused");
    ok(deny?.detail?.tool === "web_fetch", "🔴 …and WHICH tool was refused — `web_fetch` and `post_file` share the row shape, so the tool is what tells them apart");
  } finally {
    registerOperationalStore(live);
    resetOperationalStore();
  }
}

{
  const fenceSeat = {
    channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.9"), generation: 5 })}` },
    session: { id: "fence-task", auth: { current: { attributes: { oe_grain: "task" } } } },
  };
  const kit = (await resolveWindowGated((await import("../agent/tools/sandbox_tools.js")).default, fenceSeat as unknown as BindableContext)) as Record<string, ToolDefinition> | null;

  ok(kit !== null && typeof kit.web_fetch?.execute === "function", "the task-worker grain mounts a web_fetch");
  ok(typeof kit!.web_fetch.toModelOutput === "function", "…which still carries its untrusted-projection toModelOutput (the extra wrap did not drop it)");
  const m = await refusal(() => kit!.web_fetch.execute({ url: "https://evil.test/steal" }, fenceSeat as unknown as ToolContext));
  ok(
    m.includes("web_fetch:") && m.includes('"evil.test"') && m.includes("egress allow-list"),
    "🔴 THE WIRING: the tool the agent actually holds refuses an un-allowlisted host with the legible policy refusal — the hole OPE-308 found is closed at the mount, not just in a helper",
  );
}

{
  type HopHooks = { __oeWebFetchHopGuard?: (rawUrl: string, hop: number) => Promise<void>; __oeWebFetchHopPatched?: boolean };
  const hooks = globalThis as HopHooks;
  const allow = hostsOf([
    { host: "docs.acme.test", viaConnection: null },
    { host: "cdn.acme.test", viaConnection: null },
  ]);
  const deps = { hosts: allow, narrow: passThrough };

  ok(typeof hooks.__oeWebFetchHopGuard === "function", "loading the fence INSTALLS the hop guard, which is the only name eve's patched redirect loop can reach us by");
  ok(hooks.__oeWebFetchHopPatched === true, "🔴 the installed eve bytes publish the patched-dispatch marker — patch-package only WARNS on a failed patch, so the fence reads this rather than trusting it");

  type Row = { action: string; detail?: Record<string, unknown> };
  const rowsOf = async (fn: () => unknown): Promise<Row[]> => {
    const live = getOperationalStore();
    const rows: Row[] = [];
    registerOperationalStore({ ...live, appendAudit: async (r: Row) => void rows.push(r) } as unknown as OperationalStore);
    resetOperationalStore();
    try {
      await fn();
    } catch {
    } finally {
      registerOperationalStore(live);
      resetOperationalStore();
    }
    return rows;
  };

  function redirectingTool(chain: readonly string[]): ToolDefinition & { followed: string[] } {
    const followed: string[] = [];
    const tool = {
      name: "web_fetch",
      description: "fetch",
      inputSchema: { type: "object", properties: {} },
      execute: async (input: unknown) => {
        for (const [i, next] of chain.entries()) {
          await hooks.__oeWebFetchHopGuard!(next, i + 1);
          followed.push(next);
        }
        return { content: "ok", contentType: "text/plain", truncated: false, url: (input as { url: string }).url };
      },
    } as unknown as ToolDefinition & { followed: string[] };
    tool.followed = followed;
    return tool;
  }

  const drive = (t: ToolDefinition, url = "https://docs.acme.test/page") => withEgressFence("web_fetch", t, deps).execute({ url }, {} as ToolContext);

  {
    const t = redirectingTool(["https://cdn.acme.test/asset.png"]);
    const rows = await rowsOf(() => drive(t));
    ok(t.followed.length === 1, "🔴 a redirect from a declared host to ANOTHER declared host is FOLLOWED — the fence narrows the chain, it does not forbid one");
    const allows = rows.filter((r) => r.action === "egress.hostside.allow");
    ok(allows.length === 2, "🔴 …and the chain leaves TWO audit rows, one per hop — the trail says what was reached, not only what was asked for");
    ok(allows[0]?.detail?.host === "docs.acme.test" && allows[0]?.detail?.hop === 0, "hop 0 names the URL the model supplied");
    ok(allows[1]?.detail?.host === "cdn.acme.test" && allows[1]?.detail?.hop === 1, "🔴 hop 1 names the host the RESPONSE chose — the row the fence never used to write at all");
    ok(
      allows.every((r) => r.detail?.plane === "host" && r.detail?.unit === "call" && r.detail?.outcome === "allowed" && r.detail?.credential === null),
      "…both rows carry the shared cross-plane egress shape (OPE-1547), and neither claims a credential rode along",
    );
    ok(allows.every((r) => r.detail?.dispatch === "framework"), "…and both are marked admission rows: eve dispatches, so OE never sees the settlement to report");
    ok(rows.every((r) => r.action !== "egress.hostside.deny"), "negative control: an all-declared chain writes NO deny row");
  }

  {
    const t = redirectingTool(["https://evil.test/steal"]);
    const rows = await rowsOf(() => drive(t));
    ok(t.followed.length === 0, "🔴 THE HOLE, CLOSED: a redirect to an UNDECLARED host is refused BEFORE it is followed");
    const m = await refusal(() => drive(redirectingTool(["https://evil.test/steal"])));
    ok(m === egressReachDenial("web_fetch", "evil.test", "not-allowlisted"), "🔴 …with the SAME refusal text a direct call to that host gets — one protocol, not a second one for redirects");
    ok(m.includes('"evil.test"'), "…which NAMES the hop host, not the allow-listed host the model asked for");
    const deny = rows.find((r) => r.action === "egress.hostside.deny");
    ok(deny?.detail?.host === "evil.test", "🔴 …and the refusal row names the HOP host — the row whose absence let the old chain read as a clean fetch");
    ok(deny?.detail?.reason === "not-allowlisted" && deny?.detail?.tool === "web_fetch", "…with the same reason and tool a direct deny carries");
    ok(deny?.detail?.plane === "host" && deny?.detail?.unit === "call" && deny?.detail?.outcome === "denied", "…in the same row shape as a direct refusal");
    ok(
      deny?.detail?.hop === 1 && deny?.detail?.dispatch === "framework",
      "🔴 …and the row says WHICH HOP: the refusal text is the one a direct call gets, so without this an exfil bounce off a declared host reads as the model typing evil.test itself",
    );
    ok(rows.filter((r) => r.action === "egress.hostside.allow").length === 1, "…and only hop 0 was ever admitted");
  }

  {
    const self = "https://docs.acme.test/loop";
    const t = redirectingTool(Array.from({ length: MAX_REDIRECT_HOPS + 1 }, () => self));
    const rows = await rowsOf(() => drive(t));
    ok(t.followed.length === MAX_REDIRECT_HOPS, `🔴 a redirect loop between DECLARED hosts stops at ${MAX_REDIRECT_HOPS} hops — the allow-list would admit every one of them`);
    const m = await refusal(() => drive(redirectingTool(Array.from({ length: MAX_REDIRECT_HOPS + 1 }, () => self))));
    ok(m === redirectBoundDenial("web_fetch", "docs.acme.test"), "…refused with the bound's own text, not the allow-list refusal");
    ok(!m.includes(EGRESS_REPORT_PROTOCOL), "🔴 …which does NOT carry the widening protocol: a loop is not a host the operator should be asked to declare");
    const deny = rows.find((r) => r.action === "egress.hostside.deny");
    ok(deny?.detail?.reason === "redirect-bound" && deny?.detail?.hop === MAX_REDIRECT_HOPS + 1, "…and the row says the bound was the cause, and at which hop");
    ok(deny?.detail?.dispatch === "framework", "…carrying the same two fields every other row of the chain does — one shape across allowed, denied and bounded");
  }

  {
    const rows = await rowsOf(() => assertEgressReach(CTX, "https://evil.test/x", { tool: "web_fetch", hosts: allow, narrow: passThrough }));
    const deny = rows.find((r) => r.action === "egress.hostside.deny");
    ok(deny !== undefined && deny.detail?.hop === undefined && deny.detail?.dispatch === undefined, "negative control: a reach deny with no hop context carries neither field");
  }

  {
    const m = await refusal(() => hooks.__oeWebFetchHopGuard!("https://cdn.acme.test/x", 1));
    ok(m.includes("outside the egress fence's scope"), "🔴 a hop offered with no fence scope open is REFUSED, not followed — fail-closed on 'I cannot see whose allow-list applies'");
    ok(m.includes("cdn.acme.test"), "…and names the hop it refused, even though the host itself is declared for other callers");
  }

  {
    const saved = hooks.__oeWebFetchHopPatched;
    hooks.__oeWebFetchHopPatched = undefined;
    let rows: Row[] = [];
    let m = "";
    const t = redirectingTool([]);
    try {
      rows = await rowsOf(async () => {
        m = await refusal(() => drive(t));
      });
    } finally {
      hooks.__oeWebFetchHopPatched = saved;
    }
    ok(m.includes(HOP_HOOK_ABSENT), "🔴 with the eve patch missing, `web_fetch` is refused OUTRIGHT — a broken patch costs the tool, never the control");
    ok(t.followed.length === 0 && rows.length === 0, "…before any dispatch and before any row: a fetch that will be refused leaves no 'admitted' trail behind it");
    ok(hooks.__oeWebFetchHopPatched === true, "negative control: the marker is restored, so the cases above were not passing on a stale global");
  }
}

console.log(
  `\n✓ web-fetch-fence: ${n} assertions passed (shared reach decision + legible refusal + live-resolver default + break-glass revoke parity + audited deny + real mounted wiring + per-hop redirect fence)\n`,
);
