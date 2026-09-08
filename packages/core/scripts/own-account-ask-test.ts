import { adoptedOwnAccountAsk, parseOwnAccountStamp, renderOwnAccountStamp } from "../agent/connections/own-account-carriage.js";
import {
  actingIdentityAuditDetail,
  ambiguousAccountRefusal,
  decideActingIdentity,
  namedOwnAccountVendor,
  ownAccountRefusal,
  personalRouteRefusal,
  type ActingIdentityVerdict,
  type OwnAccountAsk,
  type OwnAccountVendor,
} from "../agent/connections/own-account-ask.js";
import { decideConnectorActingIdentity, holdsPersonalGrant, ownAccountAskFromMessages } from "../agent/connections/own-account-gate.js";
import { renderWakeEnvelope } from "../agent/channels/wake-envelope.js";
import type { CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";
import type { BindableContext } from "../agent/identity/binding.js";

let failures = 0;
function ok(cond: boolean, what: string): void {
  if (cond) {
    console.log(`  ✓ ${what}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${what}`);
}

const NOTION: OwnAccountVendor = { aliases: ["notion.so"], connector: "notion" };
const VENDORS = [NOTION];

console.log("§1 the grammar");

ok(namedOwnAccountVendor(["read a Notion page using my own Notion account"], VENDORS)?.connector === "notion", "the live phrasing is recognised");
ok(namedOwnAccountVendor(["Can you check my personal notion account for the Q3 doc?"], VENDORS) !== undefined, '"my personal notion account" is recognised');
ok(namedOwnAccountVendor(["use my own notion credentials please"], VENDORS) !== undefined, '"my own notion credentials" is recognised');
ok(namedOwnAccountVendor(["read it with my notion.so login"], VENDORS) !== undefined, "an alias carries the match");
ok(namedOwnAccountVendor(["read the spec in Notion with my own account"], VENDORS) !== undefined, "the vendor may sit outside the possessive phrase, in the same sentence");

ok(namedOwnAccountVendor(["read the Notion page about Q3"], VENDORS) === undefined, "a plain Notion ask names no account");
ok(namedOwnAccountVendor(["read my Notion page about Q3"], VENDORS) === undefined, "a page a person OWNS is not an account ask");
ok(namedOwnAccountVendor(["use the team Notion account for this"], VENDORS) === undefined, "the TEAM account alone is not an own-account ask");
ok(namedOwnAccountVendor(["check my own account"], VENDORS) === undefined, "no vendor named ⇒ no match");
ok(namedOwnAccountVendor(["read my own account notes. Then open Notion."], VENDORS) === undefined, "the window is ONE sentence, not the message");
ok(namedOwnAccountVendor(["Read the Notion page about my accounts payable process"], VENDORS) === undefined, '"my accounts payable" is ordinary business language');
ok(namedOwnAccountVendor(["Check the Notion doc my account manager wrote"], VENDORS) === undefined, '"my account manager" is a person, not a credential');
ok(namedOwnAccountVendor(["Summarise my Notion identity review doc"], VENDORS) === undefined, '"identity" is not an account noun');
ok(namedOwnAccountVendor(["read my notion workspace access policy page"], VENDORS) === undefined, '"workspace access" is not an account noun');
ok(namedOwnAccountVendor(["use our own notion account"], VENDORS) === undefined, '"our own" usually means the team\'s, so it does not match');
ok(
  namedOwnAccountVendor(["read the Q3 page in Notion while I check my own GitHub account"], VENDORS) === undefined,
  "🔴 a possessive naming ANOTHER vendor's account is not a Notion ask, however the sentence names Notion",
);
ok(
  namedOwnAccountVendor(["read the Notion page while I check my own account at the bank"], VENDORS) === undefined,
  "…and a possessive too far from the vendor's own name is not bound to it either",
);
ok(
  namedOwnAccountVendor(["read it in Notion with my own GitHub account"], VENDORS) === undefined,
  "🔴 an ADJACENT vendor does not rescue a possessive that names another vendor's account inside itself",
);
ok(namedOwnAccountVendor([], VENDORS) === undefined, "no messages ⇒ no ask");
ok(namedOwnAccountVendor(["use my own notion account"], []) === undefined, "no vendors admitted ⇒ no ask");

{
  const envelope = (messages: readonly { readonly body: string; readonly trigger?: boolean }[]): string =>
    renderWakeEnvelope({
      channel: { id: "C0EXGENRL", memberCount: 3, type: "group" },
      currentTime: "2026-09-07T18:00:00Z",
      messages: messages.map((m, i) => ({
        author: m.trigger === true ? "Rowan" : "Colleague",
        body: m.body,
        from: "human" as const,
        id: `${i + 1}.0`,
        sentAt: "2026-09-07T17:5" + String(i) + ":00Z",
        trust: "peer" as const,
        ...(m.trigger === true ? { trigger: true } : {}),
      })),
      reason: "channel-activity",
    });

  const backscrollAsks = envelope([
    { body: "read a Notion page using my own Notion account" },
    { body: "read the Q3 spec page in Notion", trigger: true },
  ]);
  ok(
    ownAccountAskFromMessages([backscrollAsks], VENDORS) === undefined,
    "🔴 an own-account ask in the BACKSCROLL does not become this requester's ask — no false refusal",
  );
  const triggerAsks = envelope([
    { body: "morning all" },
    { body: "read a Notion page using my own Notion account", trigger: true },
  ]);
  ok(ownAccountAskFromMessages([triggerAsks], VENDORS)?.connector === "notion", "…while the SAME ask in the trigger element is recognised");
  ok(ownAccountAskFromMessages(["read a Notion page using my own Notion account"], VENDORS) !== undefined, "a raw body still matches — the reduction only touches envelopes");
  const coalesced = `${envelope([{ body: "read a Notion page using my own Notion account", trigger: true }])}\n${envelope([{ body: "and the Q3 spec please", trigger: true }])}`;
  ok(ownAccountAskFromMessages([coalesced], VENDORS) === undefined, "…and a COALESCED delivery naming no single author resolves nothing, rather than picking one");
}

const both = namedOwnAccountVendor(["use my own Notion account, not the team account"], VENDORS);
ok(both !== undefined && both.ambiguous, "a sentence naming BOTH accounts is an AMBIGUOUS ask, not a silent team read");
ok(namedOwnAccountVendor(["please use my own notion account and not the shared integration"], VENDORS)?.ambiguous === true, "…however the two halves are spelled");
ok(namedOwnAccountVendor(["read a Notion page using my own Notion account"], VENDORS)?.ambiguous === false, "negative control: a plain own-account ask is NOT ambiguous");

console.log("§2 the decision");

const ask: OwnAccountAsk = { ambiguous: false, connector: "notion" };
const ambiguousAsk: OwnAccountAsk = { ambiguous: true, connector: "notion" };

const noAsk = decideActingIdentity({ callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, personalGrantHeld: false });
ok(noAsk.identity === "install" && noAsk.refusal === undefined, "no ask ⇒ the install identity, unrefused (test 3: unchanged behaviour)");
ok(noAsk.reason === "no-own-account-ask" && !noAsk.askRecognised, "…and the row's reason says why");

const noGrant = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, personalGrantHeld: false });
ok(noGrant.identity === undefined && noGrant.refusal !== undefined, "an own-account ask with NO grant refuses and names no runnable identity (test 1)");
ok(noGrant.requiredIdentity === "human-acting", "…while still recording what the request required");
ok(noGrant.reason === "own-account-ask-no-grant", "…with the reason that says it was the ask, not an error");
ok(noGrant.refusal?.includes("request_credential_grant") === true, "…and the refusal names the consent route when one exists here");

const noRoute = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: false, personalGrantHeld: false });
ok(noRoute.refusal !== undefined && !noRoute.refusal.includes("request_credential_grant"), "no consent route ⇒ the refusal does NOT offer a tool that is not mounted");
ok(noRoute.refusal?.includes("no domain here admits one") === true, "…it says plainly that there is no flow to start");
ok(noRoute.reason === "own-account-ask-no-grant", "…and the verdict is the same refusal either way");

const ambiguous = decideActingIdentity({ ask: ambiguousAsk, callerCanSpendPersonal: true, connector: "notion", consentRouteAvailable: true, personalGrantHeld: true });
ok(ambiguous.identity === undefined && ambiguous.refusal !== undefined, "🔴 an AMBIGUOUS ask refuses even with a grant held and a caller that could spend it");
ok(ambiguous.reason === "own-account-ask-ambiguous" && ambiguous.refusal?.includes("which") === true, "…and asks the member which account they meant");

const held = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, personalGrantHeld: true });
ok(held.requiredIdentity === "human-acting" && held.identity === undefined, "an own-account ask WITH a grant requires the human-acting identity (test 2)");
ok(held.refusal?.includes("grant__") === true, "…and a caller with no personal arm is routed to the granted tool");

const heldSpendable = decideActingIdentity({ ask, callerCanSpendPersonal: true, connector: "notion", consentRouteAvailable: true, personalGrantHeld: true });
ok(heldSpendable.identity === "human-acting" && heldSpendable.refusal === undefined, "a caller that CAN spend the personal identity runs, unrefused");

let installOnAsk = 0;
let fieldMismatch = 0;
for (const a of [ask, ambiguousAsk]) {
  for (const personalGrantHeld of [false, true]) {
    for (const consentRouteAvailable of [false, true]) {
      for (const callerCanSpendPersonal of [false, true]) {
        const v = decideActingIdentity({ ask: a, callerCanSpendPersonal, connector: "notion", consentRouteAvailable, personalGrantHeld });
        if (v.identity === "install") installOnAsk += 1;
        if ((v.identity === undefined) !== (v.refusal !== undefined)) fieldMismatch += 1;
      }
    }
  }
}
ok(installOnAsk === 0, "NO combination runs an own-account ask under the install identity");
ok(fieldMismatch === 0, "🔴 `identity` is absent EXACTLY when `refusal` is present, over all 16 combinations");

ok(ownAccountRefusal("notion", true) !== ownAccountRefusal("notion", false), "the two refusal sentences differ — the route half is real");
ok(personalRouteRefusal("notion").includes("notion"), "the granted-tool refusal names the connector");
ok(ambiguousAccountRefusal("notion").includes("notion"), "the ambiguity refusal names the connector");

const detail = actingIdentityAuditDetail(noGrant, "notion", "read_notion_page");
ok(detail.connector === "notion" && detail.reason === "own-account-ask-no-grant" && detail.refused === true, "the audit detail names connector, reason and refusal");
ok(detail.identity === undefined && detail.requiredIdentity === "human-acting", "…names NO runnable identity for a call that never ran, but says what was required");
ok(detail.askRecognised === true, "…and records THAT an ask was recognised");
const smuggled = { ...noGrant, askText: "read a page using my own Notion account" } as ActingIdentityVerdict;
const smuggledRow = JSON.stringify(actingIdentityAuditDetail(smuggled, "notion", "read_notion_page"));
ok(!smuggledRow.includes("my own"), "🔴 the audit row carries NO member sentence — a verdict field holding one is dropped, not copied");
ok(!smuggledRow.includes("askText"), "…and the unknown key itself never reaches the append-only record");
ok(noGrant.refusal !== undefined && !smuggledRow.includes(noGrant.refusal), "…and the refusal sentence is reported as `refused`, never quoted into the row");
ok(actingIdentityAuditDetail(noAsk, "notion", "read_notion_page").identity === "install", "…while an ordinary read's row names the identity it used");

console.log("§3 the carriage");

const roundTrip = parseOwnAccountStamp(renderOwnAccountStamp("sess-1", ask));
ok(roundTrip?.ask.connector === "notion" && roundTrip.ask.ambiguous === false, "render/parse round-trips a plain ask");
const roundTripAmbiguous = parseOwnAccountStamp(renderOwnAccountStamp("sess-1", ambiguousAsk));
ok(roundTripAmbiguous?.ask.ambiguous === true, "…and carries the ambiguity flag");
ok(!renderOwnAccountStamp("sess-1", ask).includes(" "), "🔴 the wire shape carries identifiers only — no member words ride the event log");
ok(parseOwnAccountStamp("sess-1") === undefined, "a one-field value is not a stamp");
ok(parseOwnAccountStamp("|notion") === undefined, "an empty session half is not a stamp");
ok(parseOwnAccountStamp("sess-1|notion|nonsense") === undefined, "an unknown third field is not a stamp");
ok(parseOwnAccountStamp(undefined) === undefined, "an absent value is not a stamp");

function ctxWith(stamp: string | unknown, sessionId: string, parentRoot?: string): BindableContext {
  return {
    session: {
      auth: { current: { attributes: { oe_own_account_ask: stamp } } },
      id: sessionId,
      ...(parentRoot === undefined ? {} : { parent: { rootSessionId: parentRoot } }),
    },
  } as unknown as BindableContext;
}

function tokenOnlyChildCtx(stamp: string, sessionId: string, parent: string): BindableContext {
  return {
    channel: { continuationToken: `subagent:${parent}:call_1`, kind: "subagent" },
    session: { auth: { current: { attributes: { oe_own_account_ask: stamp } } }, id: sessionId },
  } as unknown as BindableContext;
}

const seatStamp = renderOwnAccountStamp("seat-1", ask);
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1"), VENDORS)?.connector === "notion", "the seat that stamped it adopts it");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "worker-9", "seat-1"), VENDORS)?.connector === "notion", "a worker whose ROOT is that seat adopts it");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("other-seat", ask), "worker-9", "seat-1"), VENDORS) === undefined, "a stamp from ANOTHER session is not adopted");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("other-seat", ask), "seat-1"), VENDORS) === undefined, "…nor by an unrelated seat holding a stale bag");
ok(adoptedOwnAccountAsk(ctxWith([seatStamp], "seat-1"), VENDORS)?.connector === "notion", "eve's string[] collapse is tolerated");
ok(adoptedOwnAccountAsk(tokenOnlyChildCtx(seatStamp, "worker-9", "seat-1"), VENDORS)?.connector === "notion", "🔴 a worker whose ONLY linkage is the subagent token adopts it");
ok(adoptedOwnAccountAsk(tokenOnlyChildCtx(renderOwnAccountStamp("other-seat", ask), "worker-9", "seat-1"), VENDORS) === undefined, "…and the token arm still refuses a stamp naming another session");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1"), [{ connector: "linear" }]) === undefined, "🔴 a stamp for ANOTHER vendor is not adopted");
ok(adoptedOwnAccountAsk({} as BindableContext, VENDORS) === undefined, "an empty context adopts nothing");

console.log("§4 the gate");

const NOW = "2026-09-07T20:00:00.000Z";
function row(over: Partial<CredentialGrantRow> = {}): CredentialGrantRow {
  return {
    connector: "notion",
    createdAt: "2026-09-07T10:00:00.000Z",
    expiresAt: "2026-09-08T10:00:00.000Z",
    id: "grant-1",
    status: "active",
    ...over,
  } as CredentialGrantRow;
}

ok(holdsPersonalGrant([row()], "notion", NOW), "a live row is a held grant");
ok(!holdsPersonalGrant([row({ status: "revoked" })], "notion", NOW), "a revoked row is not");
ok(!holdsPersonalGrant([row({ expiresAt: "2026-05-11T23:30:00.000Z" })], "notion", NOW), "a row past its expiry is not, whatever its status column says");
ok(!holdsPersonalGrant([row({ connector: "linear" })], "notion", NOW), "another connector's row is not");
ok(!holdsPersonalGrant([], "notion", NOW), "no rows ⇒ no grant");

interface GateRun {
  readonly rows: Record<string, unknown>[];
  readonly verdict: Awaited<ReturnType<typeof decideConnectorActingIdentity>>;
}
async function runGate(over: {
  ask?: () => OwnAccountAsk | undefined;
  grants?: () => Promise<readonly CredentialGrantRow[]>;
  consentRouteAvailable?: () => boolean;
}): Promise<GateRun> {
  const rows: Record<string, unknown>[] = [];
  const verdict = await decideConnectorActingIdentity({
    ask: over.ask ?? (() => undefined),
    audit: async (detail) => {
      rows.push(detail);
    },
    callerCanSpendPersonal: false,
    consentRouteAvailable: over.consentRouteAvailable ?? (() => true),
    grants: over.grants ?? (async () => []),
    nowIso: NOW,
    tool: "read_notion_page",
    vendor: NOTION,
  });
  return { rows, verdict };
}

let grantReads = 0;
const plain = await runGate({
  grants: async () => {
    grantReads += 1;
    return [];
  },
});
ok(plain.verdict.identity === "install" && plain.verdict.refusal === undefined, "no ask ⇒ the install identity runs");
ok(grantReads === 0, "…and the ordinary turn pays no grant lookup");
ok(plain.rows.length === 1 && plain.rows[0]?.identity === "install", "…and exactly ONE row names the identity it used");

const refused = await runGate({ ask: () => ask });
ok(refused.verdict.refusal !== undefined, "an own-account ask with no grant refuses the team call");
ok(refused.rows.length === 1 && refused.rows[0]?.refused === true && refused.rows[0]?.reason === "own-account-ask-no-grant", "…and writes one row saying why");

const withGrant = await runGate({ ask: () => ask, grants: async () => [row()] });
ok(withGrant.verdict.requiredIdentity === "human-acting" && withGrant.verdict.refusal !== undefined, "an own-account ask WITH a grant requires the human-acting identity");
ok(withGrant.rows[0]?.requiredIdentity === "human-acting" && withGrant.rows[0]?.identity === undefined, "…and the row names it as REQUIRED, not as run");

const ambiguousRun = await runGate({ ask: () => ambiguousAsk, grants: async () => [row()] });
ok(ambiguousRun.verdict.refusal !== undefined && ambiguousRun.rows[0]?.reason === "own-account-ask-ambiguous", "an ambiguous ask refuses and names its own reason");

const unreadableTurn = await runGate({
  ask: () => {
    throw new Error("no context");
  },
});
ok(unreadableTurn.verdict.identity === "install", "an unreadable turn resolves NO ask ⇒ today's behaviour");

const unreadableStore = await runGate({
  ask: () => ask,
  grants: async () => {
    throw new Error("store down");
  },
});
ok(unreadableStore.verdict.refusal !== undefined, "a readable ask whose GRANT LOOKUP fails refuses — silence is never evidence of a grant");

const unreadableRoute = await runGate({
  ask: () => ask,
  consentRouteAvailable: () => {
    throw new Error("no config");
  },
});
ok(unreadableRoute.verdict.refusal?.includes("request_credential_grant") === false, "an unreadable consent route offers no tool it cannot promise");

const auditThrows = await decideConnectorActingIdentity({
  ask: () => ask,
  audit: async () => {
    throw new Error("audit down");
  },
  callerCanSpendPersonal: false,
  consentRouteAvailable: () => true,
  grants: async () => [],
  nowIso: NOW,
  tool: "read_notion_page",
  vendor: NOTION,
});
ok(auditThrows.refusal !== undefined, "a failed audit write never swallows the verdict");

console.log(failures === 0 ? "\nown-account gate: PASS" : `\nown-account gate: ${String(failures)} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
