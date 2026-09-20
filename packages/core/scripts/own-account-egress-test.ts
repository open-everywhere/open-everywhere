import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-own-account-egress-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { resolveAccessFor, OWN_ACCOUNT_EGRESS_REFUSAL_ACTION } = await import("../agent/access/request.js");
const { compileNetworkPolicy } = await import("../agent/access/egress.js");
const { renderOwnAccountStamp } = await import("../agent/connections/own-account-carriage.js");
const { readAudit } = await import("../agent/audit/audit.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type ConnectorCredentials = import("../agent/access/connector-credentials.js").ConnectorCredentials;

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const SURFACE = "slack/T0EXAMPLE/C0EXCHAN003";

const catalogues: readonly ConnectorCredentials[] = [
  {
    connector: "notion",
    allows: ["api-key"],
    credentials: [
      {
        id: "team-key",
        type: "api-key",
        secretRef: "NOTION_TEAM_KEY",
        broker: "env",
        endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET"] },
      },
    ],
  },
];

registerSlackFixtureMapper();
registerConfig({
  loadBundles: () => [
    defineBundle({
      name: "notion-connectors",
      connections: [
        {
          id: "notion-rest",
          credentialType: "bearer",
          secretRef: "NOTION_TEAM_KEY",
          broker: "env",
          allowedWebsites: ["api.notion.com"],
          methods: ["GET"],
        },
      ],
      domains: ["raw.githubusercontent.com"],
    }),
  ],
  loadBindings: () => [defineBinding({ bundle: "notion-connectors", scope: { level: "surface", surface: SURFACE } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  loadConnectorCredentials: () => catalogues,
  domainsForSurface: () => [],
});

const workerCtx = (stamp: string | undefined, sessionId = "worker-9"): BindableContext =>
  ({
    channel: { kind: "slack" },
    session: {
      id: sessionId,
      parent: { rootSessionId: "seat-1" },
      auth: {
        current: {
          principalId: "U0EXUSER003",
          principalType: "user",
          attributes: {
            team_id: "T0EXAMPLE",
            channel_id: "C0EXCHAN003",
            channel_type: "channel",
            user_id: "U0EXUSER003",
            oe_platform: "slack",
            oe_wake_id: "w1",
            oe_grain: "standing",
            oe_window_token: "tok",
            ...(stamp === undefined ? {} : { oe_own_account_ask: stamp }),
          },
        },
      },
    },
  }) as unknown as BindableContext;

const hostsOf = async (ctx: BindableContext): Promise<readonly string[]> => {
  const policy = await compileNetworkPolicy(
    resolveAccessFor(ctx),
    async () => ({ Authorization: "Bearer ***" }),
    async (ids) => ids,
  );
  return typeof policy === "string" ? [] : Object.keys(policy.allow ?? {}).sort();
};

const plain = await hostsOf(workerCtx(undefined));
ok(plain.includes("api.notion.com"), `a worker with no ask reaches the vendor host on the team key (got ${plain.join(", ")})`);
ok(plain.includes("raw.githubusercontent.com"), "…and the credential-less domain");

const asked = await hostsOf(workerCtx(renderOwnAccountStamp("seat-1", "turn_4", { connector: "notion", ambiguous: false })));
ok(!asked.includes("api.notion.com"), `🔴 the vendor host is WITHHELD after an own-account ask (got ${asked.join(", ")})`);
ok(asked.includes("raw.githubusercontent.com"), "…and nothing else is taken — a credential-less host stamps no identity");

const access = resolveAccessFor(workerCtx(renderOwnAccountStamp("seat-1", "turn_4", { connector: "notion", ambiguous: false })));
const refusals = access.ownAccountEgressRefusals ?? [];
ok(refusals.length === 1, `one refusal is recorded on the resolved access (got ${refusals.length})`);
ok(refusals[0]?.viaConnection === "notion-rest", "…naming the connection whose key would otherwise have been stamped");

const otherVendor = await hostsOf(workerCtx(renderOwnAccountStamp("seat-1", "turn_4", { connector: "not-a-vendor", ambiguous: false })));
ok(otherVendor.includes("api.notion.com"), "a stamp naming a vendor with no grant route withholds nothing");

{
  const { ownAccountWithholdingProblems } = await import("../agent/access/lint.js");
  const blind: ConnectorCredentials[] = [
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "team-key", type: "api-key", secretRef: "NOTION_TEAM_KEY", broker: "env" }] },
  ];
  ok(ownAccountWithholdingProblems(["notion"], blind).length === 1, "🔴 a credential-grant connector with no declared endpoint hosts is a config-lint failure");
  ok(ownAccountWithholdingProblems(["notion"], catalogues as ConnectorCredentials[]).length === 0, "…and this suite's own catalogue, which declares them, passes it");
}

const foreign = await hostsOf(workerCtx(renderOwnAccountStamp("some-other-seat", "turn_4", { connector: "notion", ambiguous: false })));
ok(foreign.includes("api.notion.com"), "a stamp naming a session this worker cannot adopt withholds nothing");

const seatCtx = (turnId: string, stampTurn: string): BindableContext =>
  ({
    channel: { kind: "slack" },
    session: {
      id: "seat-1",
      turn: { id: turnId },
      auth: {
        current: {
          principalId: "U0EXUSER003",
          principalType: "user",
          attributes: {
            team_id: "T0EXAMPLE",
            channel_id: "C0EXCHAN003",
            channel_type: "channel",
            user_id: "U0EXUSER003",
            oe_platform: "slack",
            oe_wake_id: "w1",
            oe_grain: "standing",
            oe_window_token: "tok",
            oe_own_account_ask: renderOwnAccountStamp("seat-1", stampTurn, { connector: "notion", ambiguous: false }),
          },
        },
      },
    },
  }) as unknown as BindableContext;

const sameTurn = await hostsOf(seatCtx("turn_4", "turn_4"));
ok(!sameTurn.includes("api.notion.com"), "a SEAT reading in the turn its own ask landed on withholds the vendor host too");
const laterTurn = await hostsOf(seatCtx("turn_9", "turn_4"));
ok(laterTurn.includes("api.notion.com"), "🔴 …and the NEXT turn does not — the withholding is bounded to the turn the ask was made in");

{
  const { assertEgressReach } = await import("../agent/access/host-egress.js");
  const asking = workerCtx(renderOwnAccountStamp("seat-1", "turn_4", { connector: "notion", ambiguous: false }));
  let withheldErr = "";
  await assertEgressReach(asking, "https://api.notion.com/v1/search", { tool: "web_fetch" }).catch((e: unknown) => {
    withheldErr = String(e);
  });
  ok(withheldErr.includes("cannot use your own notion account"), `🔴 the host-side refusal names the ask (got ${withheldErr.slice(0, 200)})`);
  ok(withheldErr.includes("DM"), "…and points at the route that can answer it");
  ok(!withheldErr.includes("reviewed pull request"), "🔴 …and NOT at a config pull request, which would not restore this host");

  let ungrantedErr = "";
  await assertEgressReach(asking, "https://evil.test/x", { tool: "web_fetch" }).catch((e: unknown) => {
    ungrantedErr = String(e);
  });
  ok(ungrantedErr.includes("not on this session's egress allow-list"), "an ordinary ungranted host still gets the allow-list refusal");
  ok(ungrantedErr.includes("reviewed pull request"), "…and still gets the report protocol — the two absences are told apart");
}

let rows: { action: string; detail?: Record<string, unknown> }[] = [];
for (let i = 0; i < 40 && rows.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 50));
  rows = (await readAudit({ org: "default", limit: 50 })).filter((r) => r.action === OWN_ACCOUNT_EGRESS_REFUSAL_ACTION);
}
ok(rows.length >= 1, `the withholding writes an ${OWN_ACCOUNT_EGRESS_REFUSAL_ACTION} audit row (got ${rows.length})`);
const detail = rows[0]?.detail ?? {};
ok(detail["connector"] === "notion", "…naming the connector the ask named");
ok(Array.isArray(detail["hosts"]) && (detail["hosts"] as string[]).includes("api.notion.com"), "…and the host it withheld");
ok(
  Array.isArray(detail["viaConnections"]) && (detail["viaConnections"] as string[]).includes("notion-rest"),
  "…and the connection whose credential it refused to stamp",
);
ok(
  typeof detail["reason"] === "string" && (detail["reason"] as string).includes("cannot use your own notion account"),
  "…and the reason, in the words the member reads",
);

{
  const { CONNECTOR_ACTING_IDENTITY_ACTION, noteOwnAccountRouteRefusal, ownAccountRouteLabel } = await import("../agent/connections/own-account-gate.js");
  ok(ownAccountRouteLabel(["notion-rest"]) === "egress:notion-rest", "the route label names the connection whose key was not stamped");
  ok(ownAccountRouteLabel(["b", "a", "b"]) === "egress:a,b", "…and EVERY connection it cost, deduped and sorted — never just the first");
  const asking = workerCtx(renderOwnAccountStamp("seat-1", "turn_4", { connector: "notion", ambiguous: false }));
  await noteOwnAccountRouteRefusal(asking, resolveAccessFor(asking).ownAccountEgressRefusals ?? []);
  let actingRows: { action: string; detail?: Record<string, unknown> }[] = [];
  for (let i = 0; i < 40 && actingRows.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    actingRows = (await readAudit({ org: "default", limit: 100 })).filter((r) => r.action === CONNECTOR_ACTING_IDENTITY_ACTION);
  }
  ok(actingRows.length >= 1, `the withholding also writes a ${CONNECTOR_ACTING_IDENTITY_ACTION} row (got ${actingRows.length})`);
  const d = actingRows[0]?.detail ?? {};
  ok(d["connector"] === "notion", "…naming the connector the ask named");
  ok(d["refused"] === true, "🔴 …and it is a REFUSAL, never an install read that answered the ask");
  ok(d["askRecognised"] === true, "…and it records that an ask was recognised");
  ok(d["requiredIdentity"] === "human-acting", "…and the identity the request required");
  ok(d["identity"] === undefined, "🔴 …and NO identity to run under — the gate's `refused` ⇒ no `identity` contract");
  ok(d["tool"] === "egress:notion-rest", `…and the ROUTE in place of a tool name, so the refusal joins the road it stopped (got ${String(d["tool"])})`);
  ok(typeof d["reason"] === "string" && (d["reason"] as string).startsWith("own-account-ask-"), `…and the gate's own reason code (got ${String(d["reason"])})`);

  const countBefore = (await readAudit({ org: "default", limit: 500 })).filter((r) => r.action === CONNECTOR_ACTING_IDENTITY_ACTION).length;
  await noteOwnAccountRouteRefusal(asking, resolveAccessFor(asking).ownAccountEgressRefusals ?? []);
  await new Promise((r) => setTimeout(r, 400));
  const countAfter = (await readAudit({ org: "default", limit: 500 })).filter((r) => r.action === CONNECTOR_ACTING_IDENTITY_ACTION).length;
  ok(countAfter === countBefore, `🔴 a SECOND pass on the same turn wrote a second row (before ${countBefore}, after ${countAfter})`);
}

{
  const { CONNECTOR_ACTING_IDENTITY_ACTION, noteOwnAccountRouteRefusal } = await import("../agent/connections/own-account-gate.js");
  const actingCount = async (): Promise<number> => (await readAudit({ org: "default", limit: 500 })).filter((r) => r.action === CONNECTOR_ACTING_IDENTITY_ACTION).length;
  const before = await actingCount();
  const plain = await hostsOf(workerCtx(undefined));
  ok(plain.includes("api.notion.com"), "the ordinary ask still reaches the vendor host on the team key");
  const plainCtx = workerCtx(undefined);
  const plainAccess = resolveAccessFor(plainCtx);
  ok(plainAccess.ownAccountEgressRefusals === undefined, "…and nothing is recorded as withheld");
  await noteOwnAccountRouteRefusal(plainCtx, plainAccess.ownAccountEgressRefusals ?? []);
  await new Promise((r) => setTimeout(r, 400));
  const after = await actingCount();
  ok(after === before, `🔴 …and the ordinary read adds NO ${CONNECTOR_ACTING_IDENTITY_ACTION} row (before ${before}, after ${after})`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ own-account-egress: ${n} assertions passed`);
