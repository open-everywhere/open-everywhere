import assert from "node:assert/strict";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

process.env.OE_ORG = "acme-org";
process.env.OE_WORKSPACE = "ws1";
process.env.OE_SURFACE = "c1";

await import("./_register-test-config.js");

const { assertEgressReach, egressReachDenial, EGRESS_REPORT_PROTOCOL, hostReachable } = await import("../agent/access/host-egress.js");
const { withEgressFence } = await import("../agent/access/web-fetch-fence.js");
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
  const kit = (await resolveWindowGated((await import("../agent/tools/sandbox_tools.js")).default, {
    channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.9"), generation: 5 })}` },
    session: { id: "fence-task", auth: { current: { attributes: { oe_grain: "task" } } } },
  } as unknown as BindableContext)) as Record<string, ToolDefinition> | null;

  ok(kit !== null && typeof kit.web_fetch?.execute === "function", "the task-worker grain mounts a web_fetch");
  ok(typeof kit!.web_fetch.toModelOutput === "function", "…which still carries its untrusted-projection toModelOutput (the extra wrap did not drop it)");
  const m = await refusal(() => kit!.web_fetch.execute({ url: "https://evil.test/steal" }, {} as ToolContext));
  ok(
    m.includes("web_fetch:") && m.includes('"evil.test"') && m.includes("egress allow-list"),
    "🔴 THE WIRING: the tool the agent actually holds refuses an un-allowlisted host with the legible policy refusal — the hole OPE-308 found is closed at the mount, not just in a helper",
  );
}

console.log(`\n✓ web-fetch-fence: ${n} assertions passed (shared reach decision + legible refusal + live-resolver default + break-glass revoke parity + audited deny + real mounted wiring)\n`);
