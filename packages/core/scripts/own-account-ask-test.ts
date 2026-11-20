// proves: AP-MOD-core-connections-own-account-ask, AP-MOD-core-connections-own-account-carriage
// proves: AP-MOD-core-connections-own-account-gate

import { TURN_UNKNOWN, adoptedOwnAccountAsk, parseOwnAccountStamp, renderOwnAccountStamp } from "../agent/connections/own-account-carriage.js";
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
import { stampOwnAccountAsk } from "../agent/hooks/own-account-ask.js";
import { registerConfig } from "../agent/access/config.js";
import type { HookContext, HookEvent } from "eve/hooks";
import { EgressBindingDivergenceError, egressPolicyFingerprint, enforceEgress } from "../agent/hooks/egress.js";
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

const noAsk = decideActingIdentity({ callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: false });
ok(noAsk.identity === "install" && noAsk.refusal === undefined, "no ask ⇒ the install identity, unrefused (test 3: unchanged behaviour)");
ok(noAsk.reason === "no-own-account-ask" && !noAsk.askRecognised, "…and the row's reason says why");

const noGrant = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: false });
ok(noGrant.identity === undefined && noGrant.refusal !== undefined, "an own-account ask with NO grant refuses and names no runnable identity (test 1)");
ok(noGrant.requiredIdentity === "human-acting", "…while still recording what the request required");
ok(noGrant.reason === "own-account-ask-no-grant", "…with the reason that says it was the ask, not an error");
ok(noGrant.refusal?.includes("request_credential_grant") === true, "…and the refusal names the consent route when one exists here");
ok(noGrant.refusal?.includes("Hand this to a task") === true, "🔴 …and it tells the seat to hand the ask to a TASK — the seat holds no `request_credential_grant`, so naming the verb alone routes it nowhere");

const noRoute = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: false, deploymentAdmitsGrant: true, personalGrantHeld: false });
ok(noRoute.refusal !== undefined && !noRoute.refusal.includes("request_credential_grant"), "no consent route ⇒ the refusal does NOT offer a tool that is not mounted");
ok(noRoute.refusal?.includes("no domain here admits one") === true, "…it says plainly that there is no flow to start");
ok(noRoute.reason === "own-account-ask-no-grant", "…and the verdict is the same refusal either way");

const noLendingRoute = decideActingIdentity({ ask: { ambiguous: false, connector: "github" }, callerCanSpendPersonal: false, connector: "github", consentRouteAvailable: false, deploymentAdmitsGrant: false, personalGrantHeld: false });
ok(noLendingRoute.refusal?.includes("cannot lend a personal github account at all") === true, "a vendor with NO lending route is refused with the absence that is actually true");
ok(noLendingRoute.refusal?.includes("no domain here admits one") === false, "…and never with the domain sentence, which would send an operator to a setting that cannot help");
ok(noLendingRoute.refusal?.includes("request_credential_grant") === false, "…nor with a consent tool this deployment cannot mount for it");
ok(noLendingRoute.reason === "own-account-ask-no-grant" && noLendingRoute.identity === undefined, "…and the verdict is still the refusal, unchanged by the wording");
ok(noRoute.refusal?.includes("cannot lend a personal notion account at all") === false, "negative control: a vendor WITH a lending route never reads the structural sentence");

const ambiguous = decideActingIdentity({ ask: ambiguousAsk, callerCanSpendPersonal: true, connector: "notion", consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: true });
ok(ambiguous.identity === undefined && ambiguous.refusal !== undefined, "🔴 an AMBIGUOUS ask refuses even with a grant held and a caller that could spend it");
ok(ambiguous.reason === "own-account-ask-ambiguous" && ambiguous.refusal?.includes("which") === true, "…and asks the member which account they meant");

const held = decideActingIdentity({ ask, callerCanSpendPersonal: false, connector: "notion", consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: true });
ok(held.requiredIdentity === "human-acting" && held.identity === undefined, "an own-account ask WITH a grant requires the human-acting identity (test 2)");
ok(held.refusal?.includes("grant__") === true, "…and a caller with no personal arm is routed to the granted tool");

const heldSpendable = decideActingIdentity({ ask, callerCanSpendPersonal: true, connector: "notion", consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: true });
ok(heldSpendable.identity === "human-acting" && heldSpendable.refusal === undefined, "a caller that CAN spend the personal identity runs, unrefused");

let installOnAsk = 0;
let fieldMismatch = 0;
let combinations = 0;
for (const a of [ask, ambiguousAsk]) {
  for (const personalGrantHeld of [false, true]) {
    for (const consentRouteAvailable of [false, true]) {
      for (const deploymentAdmitsGrant of [false, true]) {
        for (const callerCanSpendPersonal of [false, true]) {
          const v = decideActingIdentity({ ask: a, callerCanSpendPersonal, connector: "notion", consentRouteAvailable, deploymentAdmitsGrant, personalGrantHeld });
          if (v.identity === "install") installOnAsk += 1;
          if ((v.identity === undefined) !== (v.refusal !== undefined)) fieldMismatch += 1;
          combinations += 1;
        }
      }
    }
  }
}
ok(combinations === 32, "the sweep really covers every combination — a miscounted loop proves nothing");
ok(installOnAsk === 0, "NO combination runs an own-account ask under the install identity");
ok(fieldMismatch === 0, "🔴 `identity` is absent EXACTLY when `refusal` is present, over all 32 combinations");

const routeSentences = new Set([ownAccountRefusal("notion", true, true), ownAccountRefusal("notion", false, true), ownAccountRefusal("notion", false, false)]);
ok(routeSentences.size === 3, "the three refusal sentences differ — both route halves are real");
ok(personalRouteRefusal("notion").includes("notion"), "the granted-tool refusal names the connector");
ok(personalRouteRefusal("notion").includes("Hand the read to a task"), "🔴 the granted-tool refusal does not say WHERE the lent tool lives — it mounts on this conversation's tasks, never on the seat reading this sentence");
ok(personalRouteRefusal("notion").includes("grant__"), "…while still naming the tool family, so the task knows what it is looking for");
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

const roundTrip = parseOwnAccountStamp(renderOwnAccountStamp("sess-1", "turn_0", ask));
ok(roundTrip?.ask.connector === "notion" && roundTrip.ask.ambiguous === false, "render/parse round-trips a plain ask");
ok(roundTrip?.turnId === "turn_0", "…and carries the turn half (OPE-1597)");
const roundTripAmbiguous = parseOwnAccountStamp(renderOwnAccountStamp("sess-1", "turn_0", ambiguousAsk));
ok(roundTripAmbiguous?.ask.ambiguous === true, "…and carries the ambiguity flag");
ok(!renderOwnAccountStamp("sess-1", "turn_0", ask).includes(" "), "🔴 the wire shape carries identifiers only — no member words ride the event log");
ok(parseOwnAccountStamp(renderOwnAccountStamp("sess-1", undefined, ask))?.turnId === TURN_UNKNOWN, "an unnameable turn renders the sentinel, not an empty field");
ok(parseOwnAccountStamp("sess-1") === undefined, "a one-field value is not a stamp");
ok(parseOwnAccountStamp("sess-1|turn_0") === undefined, "a two-field value is not a stamp");
ok(parseOwnAccountStamp("|turn_0|notion") === undefined, "an empty session half is not a stamp");
ok(parseOwnAccountStamp("sess-1||notion") === undefined, "an empty turn half is not a stamp");
ok(parseOwnAccountStamp("sess-1|turn_0|notion|nonsense") === undefined, "an unknown fourth field is not a stamp");
ok(parseOwnAccountStamp(undefined) === undefined, "an absent value is not a stamp");
ok(parseOwnAccountStamp("seat-1|notion") === undefined, "🔴 the pre-turn-half stamp shape is refused, not adopted");

function ctxWith(stamp: string | unknown, sessionId: string, parentRoot?: string, turnId?: string): BindableContext {
  return {
    session: {
      auth: { current: { attributes: { oe_own_account_ask: stamp } } },
      id: sessionId,
      ...(parentRoot === undefined ? {} : { parent: { rootSessionId: parentRoot } }),
      ...(turnId === undefined ? {} : { turn: { id: turnId } }),
    },
  } as unknown as BindableContext;
}

function tokenOnlyChildCtx(stamp: string, sessionId: string, parent: string, turnId?: string): BindableContext {
  return {
    channel: { continuationToken: `subagent:${parent}:call_1`, kind: "subagent" },
    session: {
      auth: { current: { attributes: { oe_own_account_ask: stamp } } },
      id: sessionId,
      ...(turnId === undefined ? {} : { turn: { id: turnId } }),
    },
  } as unknown as BindableContext;
}

const seatStamp = renderOwnAccountStamp("seat-1", "turn_4", ask);
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1"), VENDORS)?.connector === "notion", "the seat that stamped it adopts it");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "worker-9", "seat-1"), VENDORS)?.connector === "notion", "a worker whose ROOT is that seat adopts it");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("other-seat", "turn_4", ask), "worker-9", "seat-1"), VENDORS) === undefined, "a stamp from ANOTHER session is not adopted");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("other-seat", "turn_4", ask), "seat-1"), VENDORS) === undefined, "…nor by an unrelated seat holding a stale bag");
ok(adoptedOwnAccountAsk(ctxWith([seatStamp], "seat-1"), VENDORS)?.connector === "notion", "eve's string[] collapse is tolerated");
ok(adoptedOwnAccountAsk(tokenOnlyChildCtx(seatStamp, "worker-9", "seat-1"), VENDORS)?.connector === "notion", "🔴 a worker whose ONLY linkage is the subagent token adopts it");
ok(adoptedOwnAccountAsk(tokenOnlyChildCtx(renderOwnAccountStamp("other-seat", "turn_4", ask), "worker-9", "seat-1"), VENDORS) === undefined, "…and the token arm still refuses a stamp naming another session");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1"), [{ connector: "linear" }]) === undefined, "🔴 a stamp for ANOTHER vendor is not adopted");
ok(adoptedOwnAccountAsk({} as BindableContext, VENDORS) === undefined, "an empty context adopts nothing");

{
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(store: unknown, fn: () => T): T };
  };
  const { adoptDelegatedRootSession } = await import("../agent/identity/delegated-binding.js");
  const inSession = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn);
  const runIdResolverCtx = (stamp: string): BindableContext =>
    ({
      channel: { continuationToken: "subagent:wrun_DISPATCHRUN:0", kind: "subagent" },
      session: { auth: { current: { attributes: { oe_own_account_ask: stamp } } }, id: "wrun_WORKER" },
    }) as unknown as BindableContext;

  ok(
    inSession(() => {
      ok(adoptDelegatedRootSession("seat-1"), "the worker records its root seat in a fresh eve context");
      return adoptedOwnAccountAsk(runIdResolverCtx(seatStamp), VENDORS)?.connector === "notion";
    }),
    "🔴 an eve 0.70+ resolver context adopts its seat's stamp through the recorded root seat (adoptableSessions reads delegationRootSessionId)",
  );
  ok(
    inSession(() => adoptedOwnAccountAsk(runIdResolverCtx(seatStamp), VENDORS)) === undefined,
    "🔴 …and a worker that recorded NO root seat adopts nothing: its runId token names no session (negative control for the arm above)",
  );
  ok(
    inSession(() => {
      adoptDelegatedRootSession("other-seat");
      return adoptedOwnAccountAsk(runIdResolverCtx(seatStamp), VENDORS);
    }) === undefined,
    "🔴 …and a worker whose recorded root is ANOTHER seat does not adopt this seat's stamp",
  );
  ok(
    inSession(() => {
      adoptDelegatedRootSession("seat-1");
      const seatCtx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_own_account_ask: seatStamp } } }, id: "seat-2" } };
      return adoptedOwnAccountAsk(seatCtx as unknown as BindableContext, VENDORS);
    }) === undefined,
    "🔴 …and a record answers only a CHILD: a seat that is nobody's child never adopts another seat's stamp off it",
  );
}

console.log("§3b the turn half");

ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1", undefined, "turn_4"), VENDORS)?.connector === "notion", "the stamping seat adopts its own stamp on the SAME turn");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1", undefined, "turn_5"), VENDORS) === undefined, "🔴 …and NOT on a later turn — the stale-bag re-adoption OPE-1597 names");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("seat-1", "turn_5", ask), "seat-1", undefined, "turn_5"), VENDORS)?.connector === "notion", "a stamp written on THIS turn is adopted, whatever the turn is called");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "worker-9", "seat-1", "turn_0"), VENDORS)?.connector === "notion", "🔴 a worker on ITS OWN turn_0 still adopts its seat's turn_4 stamp");
ok(adoptedOwnAccountAsk(tokenOnlyChildCtx(seatStamp, "worker-9", "seat-1", "turn_1"), VENDORS)?.connector === "notion", "…and so does a token-only worker");
ok(adoptedOwnAccountAsk(ctxWith(renderOwnAccountStamp("seat-1", undefined, ask), "seat-1", undefined, "turn_9"), VENDORS)?.connector === "notion", "a stamp whose producer could not name a turn is still adopted");
ok(adoptedOwnAccountAsk(ctxWith(seatStamp, "seat-1"), VENDORS)?.connector === "notion", "…and so is any stamp when the READER cannot name its own turn");

console.log("§3c the producer's clear");

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

function producerCtx(sessionId: string, attrs: Record<string, unknown>, turnId?: string): HookContext {
  return {
    session: {
      auth: { current: { attributes: attrs } },
      id: sessionId,
      ...(turnId === undefined ? {} : { turn: { id: turnId } }),
    },
  } as unknown as HookContext;
}
function delivery(message: string): HookEvent<"delivery.consumed"> {
  return { data: { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: message }] } } as unknown as HookEvent<"delivery.consumed">;
}

const OWN_ACCOUNT_SENTENCE = "please use my own notion account for this";
const bagA: Record<string, unknown> = {};
stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), producerCtx("seat-1", bagA, "turn_1"));
ok(bagA["oe_own_account_ask"] === "seat-1|turn_1|notion", "the producer stamps session, turn and connector");

stampOwnAccountAsk(delivery("what did we ship last week?"), producerCtx("seat-1", bagA, "turn_2"));
ok(bagA["oe_own_account_ask"] === undefined, "🔴 a later delivery naming no account CLEARS this session's own stamp");

const bagB: Record<string, unknown> = {};
stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), producerCtx("seat-2", bagB, "turn_1"));
stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), producerCtx("seat-2", bagB, "turn_2"));
ok(bagB["oe_own_account_ask"] === "seat-2|turn_2|notion", "…and a second ask re-stamps with the NEW turn");

const bagC: Record<string, unknown> = { oe_own_account_ask: renderOwnAccountStamp("seat-1", "turn_1", ask) };
stampOwnAccountAsk(delivery("unrelated words"), producerCtx("worker-9", bagC, "turn_0"));
ok(bagC["oe_own_account_ask"] === "seat-1|turn_1|notion", "🔴 a stamp naming ANOTHER session is never cleared");

const bagD: Record<string, unknown> = {};
stampOwnAccountAsk(delivery(OWN_ACCOUNT_SENTENCE), producerCtx("seat-3", bagD));
ok(bagD["oe_own_account_ask"] === `seat-3|${TURN_UNKNOWN}|notion`, "a producer that cannot name its turn stamps the sentinel");

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

const ASKER = "slack/T1/U-asker";
const OTHER_OWNER = "slack/T1/U-someone-else";
ok(holdsPersonalGrant([row({ ownerPrincipalId: ASKER })], "notion", ASKER, NOW), "a live row the ASKER owns is a held grant");
ok(!holdsPersonalGrant([row({ ownerPrincipalId: ASKER, status: "revoked" })], "notion", ASKER, NOW), "a revoked row is not");
ok(!holdsPersonalGrant([row({ expiresAt: "2026-09-07T00:00:00.000Z", ownerPrincipalId: ASKER })], "notion", ASKER, NOW), "a row past its expiry is not, whatever its status column says");
ok(!holdsPersonalGrant([row({ connector: "linear", ownerPrincipalId: ASKER })], "notion", ASKER, NOW), "another connector's row is not");
ok(!holdsPersonalGrant([], "notion", ASKER, NOW), "no rows ⇒ no grant");
ok(!holdsPersonalGrant([row({ ownerPrincipalId: OTHER_OWNER })], "notion", ASKER, NOW), "🔴 SOMEBODY ELSE's live grant for the same connector is NOT this asker's held grant");
ok(holdsPersonalGrant([row({ ownerPrincipalId: OTHER_OWNER }), row({ id: "grant-2", ownerPrincipalId: ASKER })], "notion", ASKER, NOW), "NEGATIVE CONTROL: the asker's OWN row in the same set still answers, so the leg above is the owner test and not a reader that stopped finding rows");
ok(!holdsPersonalGrant([row({ ownerPrincipalId: ASKER })], "notion", undefined, NOW), "🔴 an UNVERIFIED turn names no owner and therefore holds nothing — fail closed");

interface GateRun {
  readonly rows: Record<string, unknown>[];
  readonly verdict: Awaited<ReturnType<typeof decideConnectorActingIdentity>>;
}
async function runGate(over: {
  ask?: () => OwnAccountAsk | undefined;
  grants?: () => Promise<readonly CredentialGrantRow[]>;
  consentRouteAvailable?: () => boolean;
  deploymentAdmitsGrant?: () => boolean;
}): Promise<GateRun> {
  const rows: Record<string, unknown>[] = [];
  const verdict = await decideConnectorActingIdentity({
    ask: over.ask ?? (() => undefined),
    audit: async (detail) => {
      rows.push(detail);
    },
    callerCanSpendPersonal: false,
    consentRouteAvailable: over.consentRouteAvailable ?? (() => true),
    deploymentAdmitsGrant: over.deploymentAdmitsGrant ?? (() => true),
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
  deploymentAdmitsGrant: () => true,
  grants: async () => [],
  nowIso: NOW,
  tool: "read_notion_page",
  vendor: NOTION,
});
ok(auditThrows.refusal !== undefined, "a failed audit write never swallows the verdict");

console.log("§5 the egress plane: a child may not narrow the firewall it shares");

{
  const parentPolicy = { allow: { "api.notion.com": [{ transform: [{ headers: { authorization: "Bearer TEAM" } }] }], "github.com": [] } };
  const narrowedByChild = { allow: { "github.com": [] } };
  const audited: { action: string; detail: Record<string, unknown> }[] = [];
  const applied: unknown[] = [];
  const childDeps = (policy: unknown) => ({
    resolve: () => ({ scopeKey: "slack/T1/C1", connectors: [], connectorContentOrigin: {}, connections: [], reachableHosts: [] }),
    compile: async () => policy,
    apply: async (p: unknown) => void applied.push(p),
    lastApplied: () => undefined,
    rememberApplied: () => undefined,
    lastConnectors: () => undefined,
    rememberConnectors: () => undefined,
    scope: () => ({ org: "default", platform: "slack", workspace: "T1", surface: "C1", principalId: "U1" }),
    audit: async (e: { action: string; detail?: Record<string, unknown> }) => void audited.push({ action: e.action, detail: e.detail ?? {} }),
    stamp: () => undefined,
    stampConnectorContentOrigin: () => undefined,
    parentPublishedFingerprint: async () => egressPolicyFingerprint(parentPolicy as never),
  });

  const narrowed = await enforceEgress("session.started", childDeps(narrowedByChild) as never);
  ok(narrowed.abortError !== undefined, "🔴 a worker that narrows its own egress policy for an own-account ask ABORTS the delegated job — the tripwire, not a withholding");
  ok(applied.length === 0, "…and applies nothing, so the member gets a failed job rather than a refused vendor call");
  const bareRow = audited.find((a) => a.action === "egress.policy" && a.detail["reason"] === "subagent-binding-divergence");
  ok(bareRow !== undefined, "…audited as a binding divergence");
  ok(bareRow!.detail["ownAccountWithheld"] === undefined, "…and a divergence that withheld nothing names no own-account ask — the field marks the withholding, not every abort");

  const unnarrowed = await enforceEgress("session.started", childDeps(parentPolicy) as never);
  ok(unnarrowed.abortError === undefined && applied.length === 1, "a worker that compiles what its parent published runs normally — the abort is the NARROWING, not the delegation");

  const withheld = { connector: "notion", viaConnection: "notion-rest" };
  const askAudited: { action: string; detail: Record<string, unknown> }[] = [];
  const askDeps = {
    ...childDeps(narrowedByChild),
    resolve: () => ({ scopeKey: "slack/T1/C1", connectors: [], connectorContentOrigin: {}, connections: [], reachableHosts: [], ownAccountEgressRefusals: [withheld] }),
    audit: async (e: { action: string; detail?: Record<string, unknown> }) => void askAudited.push({ action: e.action, detail: e.detail ?? {} }),
  };
  const asked = await enforceEgress("session.started", askDeps as never);
  ok(asked.abortError !== undefined, "🔴 an own-account withholding still FAILS the worker — one credential per host per session, so a child may not narrow the firewall it shares");
  ok(asked.ownAccountEgressRefusals.length === 1, "…and the pass carries the withholding out, which is what lets the hook fail it with the member's refusal");
  const askRow = askAudited.find((a) => a.action === "egress.policy" && a.detail["reason"] === "subagent-binding-divergence");
  ok(askRow !== undefined, "…and writes the divergence row before failing the child");
  ok(askRow!.detail["ownAccountWithheld"] === true, "🔴 OPE-1976: …which RECORDS that this pass also withheld the vendor's hosts, the first thing to check before chasing a binding bug");
  ok(askRow!.detail["ownAccountConnector"] === "notion", "…and the vendor whose road was withheld");
  ok(asked.abortError instanceof EgressBindingDivergenceError, "…and the abort is the TYPED divergence, which is what licenses the refusal sentence");

  const applyFailed = {
    ...childDeps(parentPolicy),
    resolve: () => ({ scopeKey: "slack/T1/C1", connectors: [], connectorContentOrigin: {}, connections: [], reachableHosts: [], ownAccountEgressRefusals: [withheld] }),
    apply: async () => {
      throw new Error("setNetworkPolicy() rejected by the backend");
    },
  };
  const blipped = await enforceEgress("session.started", applyFailed as never);
  ok(blipped.abortError !== undefined, "a session-start apply failure still ABORTS with an own-account stamp in hand — fail-closed is unchanged");
  ok(blipped.ownAccountEgressRefusals.length === 1, "…and it carries the withholding, which is exactly why the refusals list cannot be the discriminator");
  ok(
    !(blipped.abortError instanceof EgressBindingDivergenceError),
    "🔴 OPE-1976: an apply failure is NOT the divergence type, so the member is told the firewall failed rather than that their own-account ask was refused",
  );
}

console.log(failures === 0 ? "\nown-account gate: PASS" : `\nown-account gate: ${String(failures)} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
