
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-unified-audit-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
overrideSettingsForTest({ window: { topology: true } });
delete process.env.OE_CONTROL_READ_TOKENS;

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineDomain, domainForChannel } = await import("../agent/memory/domain.js");
const { definePrincipal } = await import("../agent/identity/principals.js");

const SLACK = "slack/T1/C_PAY";
const GH = "github/acme/repo";
const payments = defineDomain({
  name: "payments",
  channels: [SLACK, GH],
  ambientSupervisor: true,
  mode: "unified",
  admins: ["slack/T1/U_ADMIN"],
});
const org = defineDomain({ name: "org", match: "org" });
const domains = [payments, org];

registerConfig({
  loadBundles: () => [
    defineBundle({ name: "base", domains: ["api.example.com"] }),
    defineBundle({ name: "gh-extra", domains: ["deploy.example.com"] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "base", scope: { level: "org" } }),
    defineBinding({ bundle: "gh-extra", scope: { level: "surface", surface: "github/acme/repo" } }),
  ],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    const d = domainForChannel(`${workspaceKey}/${surface}`, domains);
    return d ? [d.name] : [];
  },
  loadPrincipals: () => [
    definePrincipal({ name: "Rowan Hale", handle: "rowan", ids: { slack: "U0EXOWNER", github: "example-owner" } }),
    definePrincipal({ name: "Sarah Kim", ids: { slack: "U_SARAH" } }),
    definePrincipal({ name: "Outsider", ids: { discord: "D_X" } }),
  ],
});

const { unifiedDomainAudit } = await import("../agent/control/views.js");
const { appendAudit, readAudit } = await import("../agent/audit/audit.js");
const {
  handleUnifiedAuditRead,
  CONTROL_READ_UNIFIED_AUDIT_PATH,
} = await import("../agent/control/read-route.js");

{
  const v = await unifiedDomainAudit({ domain: "payments" });
  ok(v.unified === true, "unified true (code gate + ambient supervisor on)");
  ok(v.domain === "payments" && v.org === "acme", "domain + org echoed");
  ok(v.containers.length === 2, "both containers audited");
  ok(JSON.stringify(v.platforms) === JSON.stringify(["github", "slack"]), "platforms span the domain, sorted");

  ok(v.agentReach.reachableHosts.includes("api.example.com"), "union includes the org-wide host");
  ok(v.agentReach.reachableHosts.includes("deploy.example.com"), "union includes the github-only host");

  const gh = v.containers.find((c) => c.platform === "github")!;
  const slack = v.containers.find((c) => c.platform === "slack")!;
  ok(gh.widens.includes("host:deploy.example.com"), "the github container is flagged as WIDENING the reach (deploy host)");
  ok(!slack.widens.includes("host:deploy.example.com"), "the slack container does not widen with the github-only host");
  ok(!gh.widens.includes("host:api.example.com"), "a host granted to BOTH containers is not a widener");

  const rowan = v.humans.find((h) => h.name === "Rowan Hale")!;
  const sarah = v.humans.find((h) => h.name === "Sarah Kim")!;
  ok(!!rowan && JSON.stringify(rowan.surfacesInDomain) === JSON.stringify(["github", "slack"]), "Rowan is on both domain surfaces");
  ok(rowan.surfacesNotIn.length === 0, "Rowan is not absent from any domain surface");
  ok(!!sarah && JSON.stringify(sarah.surfacesInDomain) === JSON.stringify(["slack"]), "Sarah is on slack only");
  ok(JSON.stringify(sarah.surfacesNotIn) === JSON.stringify(["github"]), "Sarah is NOT on github — the read-across exposure (answering github could disclose to a non-member)");
  ok(!v.humans.some((h) => h.name === "Outsider"), "a principal touching no domain platform is excluded");

  ok(JSON.stringify(v.controllers) === JSON.stringify(["slack/T1/U_ADMIN"]), "controllers = domain admins, as the qualified roster keys they are stored as");
  ok(v.notes.some((nn) => nn.includes("Pure-read")), "notes state the pure-read discipline");
  ok(v.notes.some((nn) => nn.toLowerCase().includes("privacy ordinal")), "notes flag the not-yet-enforced privacy ordinal (honest)");
}

{
  let threw = false;
  try {
    await unifiedDomainAudit({ domain: "nope" });
  } catch {
    threw = true;
  }
  ok(threw, "unknown domain name throws");
}

const SECRET = "unified-audit-test-token";
const SHA = createHash("sha256").update(SECRET, "utf-8").digest("hex");
const url = (q: string) => `https://oe.example${CONTROL_READ_UNIFIED_AUDIT_PATH}${q}`;
const call = (q: string, token?: string) =>
  handleUnifiedAuditRead(new Request(url(q), { headers: token ? { authorization: `Bearer ${token}` } : {} }));

{
  ok((await call("?domain=payments", SECRET)).status === 404, "no OE_CONTROL_READ_TOKENS → 404 (mode fully off) even with a good bearer");
}
process.env.OE_CONTROL_READ_TOKENS = `e2e-harness:${SHA}`;
{
  ok((await call("?domain=payments")).status === 401, "configured + no bearer → 401");
  ok((await call("?domain=payments", "wrong")).status === 401, "configured + wrong token → 401");
  ok((await call("", SECRET)).status === 400, "missing domain → 400");
  ok((await call("?domain=nope", SECRET)).status === 400, "unknown domain → 400");
  ok((await call("?domain=payments&sinceDays=abc", SECRET)).status === 400, "bad sinceDays → 400");
  const good = await call("?domain=payments", SECRET);
  ok(good.status === 200, "good call → 200");
  const body = (await good.json()) as { domain: string; unified: boolean; containers: unknown[] };
  ok(body.domain === "payments" && body.unified === true && body.containers.length === 2, "200 body is the audit result");
  const rows = await readAudit({ org: "acme", action: "control.service_call" });
  ok(rows.some((r) => (r.detail as { view?: string })?.view === "unified_domain_audit"), "every authenticated call is self-audited (control.service_call, view=unified_domain_audit)");
}

{
  const { platformWorkspaceForWindowDomain } = await import("../agent/channels/unified.js");
  const { dmWindowKey, formatWindowToken, parseWindowToken } = await import("../agent/channels/window-key.js");

  const dmToken = formatWindowToken(dmWindowKey("slack/T1/D999", 4));
  const dmDomain = parseWindowToken(dmToken)!.domain;
  ok(dmDomain === "oe-dm/slack/T1/D999", "a DM seat's token domain IS the reserved pseudo-domain (the thing that must not be stamped)");
  ok(
    platformWorkspaceForWindowDomain(dmDomain) === "T1",
    "🔴 R3: a DM window's audit workspace is the PLATFORM workspace (T1) recovered from the surface key inside the pseudo-domain — never `oe-dm/…`",
  );
  ok(!platformWorkspaceForWindowDomain(dmDomain).includes("oe-dm"), "…and carries no trace of the pseudo-domain prefix at all");

  ok(platformWorkspaceForWindowDomain("payments") === "payments", "a real config domain still labels as itself (byte-identical to before)");
  ok(platformWorkspaceForWindowDomain("oe-dm/") === "oe-dm/", "a malformed anchor fails SOFT to the domain string — an odd label beats a thrown audit row");
  ok(platformWorkspaceForWindowDomain("oe-dm/slack") === "oe-dm/slack", "…same for an anchor with no workspace segment");
}

{
  const { ambientProseDropDetail } = await import("../agent/channels/unified.js");

  ok(
    JSON.stringify(ambientProseDropDetail(undefined, false, false)) === JSON.stringify({ addressing: "ambient", reason: "no-reply-call" }),
    "unaddressed + no reply-tool call → addressing:ambient, reason:no-reply-call",
  );

  const nameDrop = ambientProseDropDetail(undefined, true, false);
  ok(nameDrop.addressing === "addressed-other", "addressed (name-drop/mention) but not direct-mention → addressing:addressed-other, NOT ambient");
  ok(nameDrop.reason === "no-reply-call", "same reason as the ambient case — the drop mechanism doesn't care why it was addressed");
  ok(nameDrop.addressing !== ambientProseDropDetail(undefined, false, false).addressing, "NEGATIVE CONTROL — addressed and unaddressed drops must NOT read as the same kind");

  ok(
    ambientProseDropDetail(undefined, false, true).reason === "narration-after-reply",
    "a reply already posted this turn → reason:narration-after-reply (NOT no-reply-call)",
  );
  ok(
    ambientProseDropDetail(undefined, false, true).reason !== ambientProseDropDetail(undefined, false, false).reason,
    "NEGATIVE CONTROL — replied vs not-replied must not collapse to the same reason",
  );

  ok(
    ambientProseDropDetail("direct-mention", true, false).addressing === "direct-mention",
    "a present raw addressing value is reported verbatim, never overridden by the addressed/ambient fallback",
  );
}

{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  const rowStart = src.indexOf('action: "turn.supervisor_prose_dropped"');
  ok(rowStart !== -1, "the drop row's action name is present in the source (sanity check for the slice below)");
  const detailSlice = src.slice(rowStart, src.indexOf("}).catch(() => undefined);", rowStart));
  ok(detailSlice.includes("action.text.length"), "the row reads the prose's LENGTH…");
  ok(!/action\.text[^.]/.test(detailSlice), "…and never a bare `action.text` (the prose itself) anywhere in the detail object");
}

{
  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));

  const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } = await import(
    "./_slack-test-stubs.js"
  );
  const posted: { channel: string; text: string }[] = [];
  registerSlackTestBridge({
    channel: { __fixture: "slack" } as never,
    confirmChannelInternal: async () => true,
    form: async (method: string, body: string) => {
      const p = new URLSearchParams(body);
      if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    },
  });
  registerSlackFixtureCodec();
  registerSlackFixtureMapper();
  registerSlackFixturePostArm();

  const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
  const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const store805 = getOperationalStore();
  const ORG805 = "acme";
  const DOMAIN805 = "payments";
  const CHAN805 = "C_805_LEAK";
  const TOKEN805 = unifiedSupervisorToken(DOMAIN805, 1);
  const SESSION_ID_805 = "unified-audit-ope-805-test";

  const replyTool = (await import("../agent/tools/reply.js")).default;
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const armReply = (ctx: unknown) =>
    (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]!({}, ctx) as
      | { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown> }
      | null;

  const unifiedAdapter805 = ((await import("../agent/channels/unified.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  }).adapter;
  const adapterCtx805 = { session: { continuation: { token: `unified:${TOKEN805}` } } };
  const completed805 = (message: string | null): Promise<void> =>
    unifiedAdapter805["message.completed"]!({ finishReason: "stop", message }, adapterCtx805);

  async function wake805(threadTs: string): Promise<string> {
    const id = mintWakeId();
    await registerUnifiedWakeTarget(store805, ORG805, id, { platform: "slack", channelId: CHAN805, threadTs }, new Date().toISOString(), TOKEN805);
    return id;
  }

  function replyCtxFor(turnWake: string, turnId: string): unknown {
    return {
      channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN805}` },
      session: {
        id: SESSION_ID_805,
        turn: { id: turnId, sequence: 1 },
        auth: {
          current: {
            attributes: { oe_platform: "slack", oe_grain: "standing", oe_wake_id: turnWake, oe_window_token: TOKEN805, channel_id: CHAN805, team_id: "T1" },
            principalId: "U1",
            principalType: "slack-user",
          },
        },
      },
      agent: { name: "oe", nodeId: "__root__" },
    };
  }
  async function callReply805(turnWake: string, turnId: string, text: string): Promise<{ posted?: boolean; error?: string }> {
    const ctx = replyCtxFor(turnWake, turnId);
    const armed = armReply(ctx);
    if (!armed) return { error: "reply did not arm" };
    return armed.execute({ text, wake: turnWake, done: true }, ctx).then((r) => r as { posted?: boolean }).catch((e: unknown) => ({ error: String(e) }));
  }

  function session805(): { setTurn: (turnWake: string, turnId: string, addressing?: string) => void; inSession: <T>(fn: () => Promise<T>) => Promise<T> } {
    const c = new ContextContainer();
    const setTurn = (turnWake: string, turnId: string, addressing?: string): void => {
      c.set(SessionKey, {
        sessionId: SESSION_ID_805,
        auth: {
          current: {
            attributes: {
              oe_platform: "slack",
              oe_grain: "standing",
              oe_wake_id: turnWake,
              oe_window_token: TOKEN805,
              channel_id: CHAN805,
              team_id: "T1",
              ...(addressing !== undefined ? { oe_addressing: addressing } : {}),
            },
            principalId: "U1",
            principalType: "slack-user",
          },
        },
        turn: { id: turnId, sequence: 1 },
        parent: undefined,
      });
    };
    const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
    return { setTurn, inSession };
  }

  {
    const { setTurn, inSession } = session805();
    const w0 = await wake805("805.1");
    const w1 = await wake805("805.2");
    const beforePosted = posted.length;

    await inSession(async () => {
      setTurn(w0, "turn_805a_0");
      const post = await callReply805(w0, "turn_805a_0", "Turn 0's real answer, posted via the tool.");
      ok(post.posted === true, "OPE-805a precondition: turn 0's reply posts through the real tool");
      await completed805(null);
    });
    ok(posted.length === beforePosted + 1, "OPE-805a precondition: only turn 0's tool-posted reply has reached the room so far");

    await inSession(async () => {
      setTurn(w1, "turn_805a_1", "direct-mention");
      await completed805("The weather is clear and mild.");
    });
    ok(
      posted.some((m) => m.text.includes("The weather is clear and mild.")),
      "OPE-805a: when turn 0's own message.completed runs, turn 1 correctly reads replied:false and the bridge delivers",
    );
  }

  {
    const { setTurn, inSession } = session805();
    const w0 = await wake805("805.3");
    const w1 = await wake805("805.4");
    const beforePosted = posted.length;
    const beforeDropped = (await readAudit({ org: ORG805, action: "turn.supervisor_prose_dropped" })).length;

    await inSession(async () => {
      setTurn(w0, "turn_805b_0");
      const post = await callReply805(w0, "turn_805b_0", "Turn 0's real answer, posted via the tool.");
      ok(post.posted === true, "OPE-805b precondition: turn 0's reply posts through the real tool");
    });
    ok(posted.length === beforePosted + 1, "OPE-805b precondition: only turn 0's tool-posted reply has reached the room so far");

    await inSession(async () => {
      setTurn(w1, "turn_805b_1", "direct-mention");
      await completed805("The weather is clear and mild.");
    });

    ok(
      posted.some((m) => m.text.includes("The weather is clear and mild.")),
      "🔴 OPE-805b THE FIX: turn 1's owed prose reaches the room via the addressed-mention bridge even though turn 0 never consumed its own mark — `replied` reads false because turn 1's id differs from the mark's, not because something happened to reset it",
    );
    ok(
      (await readAudit({ org: ORG805, action: "turn.supervisor_prose_dropped" })).length === beforeDropped,
      "🔴 OPE-805b: turn 1 writes NO turn.supervisor_prose_dropped row — a leaked `replied:true` would have routed it to the hard-drop branch instead of the bridge (deploy #90's exact observed row)",
    );
  }

  {
    const { setTurn, inSession } = session805();
    const w2 = await wake805("805.5");
    const droppedBefore = (await readAudit({ org: ORG805, action: "turn.supervisor_prose_dropped" })).length;
    await inSession(async () => {
      setTurn(w2, "turn_805c_0");
      const post = await callReply805(w2, "turn_805c_0", "The tool-posted answer.");
      ok(post.posted === true, "OPE-805c precondition: the reply posts");
      await completed805("…and one more thing the model said after replying.");
    });
    const dropRows = await readAudit({ org: ORG805, action: "turn.supervisor_prose_dropped" });
    ok(dropRows.length === droppedBefore + 1, "OPE-805c negative control: same-turn narration after a real reply IS dropped and audited");
    const lastDrop = dropRows[dropRows.length - 1]!.detail as { replied?: boolean; reason?: string } | undefined;
    ok(lastDrop?.replied === true, "🔴 OPE-805c NEGATIVE CONTROL: a genuine same-turn narration-after-reply still writes replied:true — the fix must not blind this legitimate case");
    ok(lastDrop?.reason === "narration-after-reply", "OPE-805c negative control: …with the narration-after-reply reason, unchanged");
  }
}

void appendAudit;

console.log(`✓ unified-audit: ${passed} assertions passed (composition view: containers/reach-union/wideners/humans-read-across/controllers/notes + route: 404/401/400/200/self-audit + OPE-779 drop-detail classification + OPE-805 cross-turn replied leak)`);
