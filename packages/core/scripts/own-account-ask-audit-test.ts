import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-own-account-ask-audit-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import ownAccountAskHook, { auditOwnAccountAsk, ownAccountAskAuditEntry, stampOwnAccountAsk } from "../agent/hooks/own-account-ask.js";
import { CONNECTOR_OWN_ACCOUNT_ASK_ACTION } from "../agent/connections/own-account-ask.js";
import { registerConfig } from "../agent/access/config.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { registerSlackFixtureManifest, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import type { HookContext, HookEvent } from "eve/hooks";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerSlackFixtureManifest();
registerSlackFixtureMapper();
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  loadConnectorCredentials: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const askCtx = (sessionId: string): HookContext =>
  ({
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { channel_id: "C-ROOM", team_id: "T1", trust_checked: "true" },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: sessionId,
    },
  }) as unknown as HookContext;

const baglessCtx = (sessionId: string): HookContext =>
  ({
    channel: { kind: "slack" },
    session: { auth: { current: null }, id: sessionId },
  }) as unknown as HookContext;

const delivery = (message: string): HookEvent<"message.received"> => ({ data: { message } }) as unknown as HookEvent<"message.received">;

const OWN_ACCOUNT_SENTENCE = "please use my own notion account for this";
const ORG = resolvePartition(askCtx("probe") as unknown as BindableContext).org;

const rowsFor = async (): Promise<{ action: string; detail?: Record<string, unknown> }[]> =>
  (await readAudit({ org: ORG })).filter((r) => r.action === CONNECTOR_OWN_ACCOUNT_ASK_ACTION) as { action: string; detail?: Record<string, unknown> }[];

const fireHook = (message: string, ctx: HookContext): void => {
  (ownAccountAskHook as unknown as { events: Record<string, (event: unknown, c: unknown) => unknown> }).events["message.received"](delivery(message), ctx);
};

const awaitRows = async (want: number): Promise<{ action: string; detail?: Record<string, unknown> }[]> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await rowsFor();
    if (rows.length >= want || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
};

console.log("1. the wired message.received handler writes one decision-point row:");
{
  fireHook(OWN_ACCOUNT_SENTENCE, askCtx("seat-1"));
  const rows = await awaitRows(1);
  eq(rows.length, 1, "🔴 the REGISTERED hook wrote exactly one row — the reachability this row exists for");
  const detail = rows[0].detail;
  eq(detail?.connector, "notion", "…naming the connector the ask was for");
  eq(detail?.askRecognised, true, "…and that an ask was recognised");
  eq(detail?.requiredIdentity, "human-acting", "…and what the ask REQUIRES, which is never the install identity");
  eq(detail?.outcome, "refuse-unless-grant-held", "…and the closed outcome, so the row is scoreable with no second read");
  eq(detail?.stamped, true, "…and that the stamp reached the bag, so a delegated worker inherits the ask");
  const rendered = JSON.stringify(detail);
  ok(!rendered.includes("please use") && !rendered.includes("for this"), "🔴 the row carries NO member words — the append-only record has no delete path");
}

console.log("2. an ordinary delivery writes nothing:");
{
  const before = (await rowsFor()).length;
  fireHook("what did we ship last week?", askCtx("seat-2"));
  const rows = await awaitRows(before + 1);
  eq(rows.length, before, "🔴 a delivery naming no account leaves NO row — without this the e2e gate on this row is vacuous");
}

console.log("3. an ask naming BOTH accounts records its own outcome:");
{
  const before = (await rowsFor()).length;
  fireHook("use my own notion account, not the team notion account", askCtx("seat-3"));
  const rows = await awaitRows(before + 1);
  eq(rows.length, before + 1, "the ambiguous ask is recognised and recorded");
  eq(rows[0].detail?.outcome, "refuse-ambiguous", "…with the outcome that says it is refused by READING it, not by looking for a grant");
}

console.log("4. an unwritable auth bag records the ask with stamped=false:");
{
  const recognition = stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), baglessCtx("seat-4"));
  ok(recognition?.ask.connector === "notion", "🔴 the ask is recognised even when nothing can be stamped — the arm that used to return early");
  eq(recognition?.stamped, false, "…and `stamped` says the delegated path would NOT inherit it");
  const before = (await rowsFor()).length;
  await auditOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), baglessCtx("seat-4"));
  const rows = await rowsFor();
  eq(rows.length, before + 1, "…and the row is still written, so the ask is not lost with the bag");
  eq(rows[0].detail?.stamped, false, "…carrying stamped=false");
  const stamped = stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), askCtx("seat-4b"));
  eq(stamped?.stamped, true, "NEGATIVE CONTROL: a writable bag reports stamped=true — the field is not a constant");
}

console.log("5. an unreadable context writes no row:");
{
  const readable = ownAccountAskAuditEntry({ ask: { ambiguous: false, connector: "notion" }, stamped: true }, {} as unknown as HookContext);
  ok(readable !== undefined, "a context with no fields still resolves the local default partition — the builder does not fail on absence");
  const unreadable = new Proxy({}, { get: () => { throw new Error("context unreadable"); } }) as unknown as HookContext;
  const entry = ownAccountAskAuditEntry({ ask: { ambiguous: false, connector: "notion" }, stamped: true }, unreadable);
  eq(entry, undefined, "🔴 a context that cannot be read writes NO row — the hook never invents a scope to key one on");
  const scoped = ownAccountAskAuditEntry({ ask: { ambiguous: false, connector: "notion" }, stamped: true }, askCtx("seat-5"));
  ok(scoped?.action === CONNECTOR_OWN_ACCOUNT_ASK_ACTION, "NEGATIVE CONTROL: a real context DOES build the entry, so part 5 is not a builder that always fails");
  ok(scoped?.org === ORG && scoped?.platform === "slack", "…keyed on the delivery's own partition");
}

console.log(`\n✓ own-account decision-point audit: ${n} assertions`);
