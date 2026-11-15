// proves: access_request.claim_withheld

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-request-claim-guard-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const {
  applyRequestClaimGuard,
  detectRequestClaims,
  auditWithheldRequestClaim,
  guardRequestClaims,
  REQUEST_CLAIM_WITHHELD_ACTION,
  WITHHELD_REQUEST_CLAIM_NOTE,
} = await import("../agent/channels/request-claim-guard.js");
const { accessRequestsProposedThisTurn, noteAccessRequestProposed, ACCESS_REQUEST_KIND } = await import(
  "../agent/channels/access-request-ledger.js"
);
const { markCardPostedThisTurn } = await import("../agent/approvals/card-signal.js");
const { readAudit } = await import("../agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn) as T;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    return;
  }
  passed++;
}

const NOTHING = { proposed: false, cardMinted: false } as const;
const PROPOSED = { proposed: true, cardMinted: false } as const;
const CARD_MINTED = { proposed: false, cardMinted: true } as const;

const SHIP_228_REPLY =
  "I've submitted the channel-scope request for this channel to widen `e2e-fixture` with POST, tied to `e2e-run-muavvcxo`. " +
  "It's pending the required approval; I'll report the card/status when it returns.";

const measured = detectRequestClaims(SHIP_228_REPLY);
ok(measured.length === 2, `CONTRACT: the measured reply carries two claims (saw ${measured.length})`);
ok(measured[0]?.shape === "submitted", "CONTRACT: the first is the submitted shape");
ok(measured[0]?.subject === "access", "CONTRACT: and it reads as an ACCESS claim, so only the access ledger may back it");
ok(measured[1]?.shape === "pending-approval", "CONTRACT: the second is the pending shape");

const struck = applyRequestClaimGuard(SHIP_228_REPLY, NOTHING);
ok(struck.withheld.length === 2, "CONTRACT: on a turn with no propose, both are withheld");
ok(!struck.body.includes("I've submitted"), "CONTRACT: the fabricated submission does not reach the room");
ok(!struck.body.includes("pending the required approval"), "CONTRACT: and neither does the pending claim beside it");
ok(struck.body.includes(WITHHELD_REQUEST_CLAIM_NOTE), "CONTRACT: the host's own line stands in their place");
ok(
  struck.body.split(WITHHELD_REQUEST_CLAIM_NOTE).length - 1 === 1,
  "CONTRACT: exactly ONE note, however many sentences were struck — three copies would read as a rendering fault",
);

const backed = applyRequestClaimGuard(SHIP_228_REPLY, PROPOSED);
ok(backed.body === SHIP_228_REPLY, "BACKED: a propose the host observed keeps the claim BYTE-IDENTICAL");
ok(backed.withheld.length === 0, "BACKED: and nothing is withheld");

const UNTOUCHED: readonly string[] = [
  "A channel-scope access request is raised in the channel it is for, not from a DM.",
  "A channel-scope access request has to be raised in the channel itself, so ask me there and I'll raise it.",
  "I haven't submitted any request — a channel grant binds to the channel's own scope.",
  "No access request was raised, because this ask has to come from the channel that needs the access.",
  "Shall I raise the access request once you ask me in the channel?",
  "If you ask in #ops I will file the request there.",
  "Your access request is still pending approval from last week.",
  "The connector is live, opened under the request Ana submitted in #ops.",
  "Nothing is pending approval on my side.",
  "I can't submit a channel-scope request from a direct message.",
];
for (const line of UNTOUCHED) {
  const r = applyRequestClaimGuard(line, NOTHING);
  ok(r.body === line, `REFUSAL: untouched — ${line}`);
}

const SIBLING_NOTES: readonly string[] = [
  "(No card was raised on this turn. A gated notion write ran on it, which means an approval already stood for this call — not that the write is ungated.)",
  "(No durable memory write is recorded for this turn, so I cannot say the note is stored.)",
];
{
  const { standingAuthorityNote } = await import("../agent/channels/approval-claim-guard.js");
  const { WITHHELD_CLAIM_NOTE } = await import("../agent/channels/memory-claim-guard.js");
  const rendered = [
    standingAuthorityNote({ approvalGateRan: true, gatedWrites: [], grants: [] }),
    standingAuthorityNote({ approvalGateRan: false, gatedWrites: [{ connection: "notion", op: "create-pages", tier: "write" }], grants: [] }),
    standingAuthorityNote({ approvalGateRan: false, gatedWrites: [], grants: [{ host: "api.notion.com", credential: "notion-rest", verb: ["POST", "PATCH"] }] }),
    WITHHELD_CLAIM_NOTE,
  ];
  for (const note of rendered) {
    ok(note !== undefined && applyRequestClaimGuard(note, NOTHING).body === note, `SIBLING: today's host-voiced note passes through untouched — ${String(note).slice(0, 40)}…`);
  }
}
for (const note of SIBLING_NOTES) {
  ok(applyRequestClaimGuard(note, NOTHING).body === note, `SIBLING: a host-voiced note passes through untouched — ${note.slice(0, 40)}…`);
}

const ORDINARY = "The deploy finished at 09:12 and the smoke gate is green. Nothing else is waiting on you.";
ok(applyRequestClaimGuard(ORDINARY, NOTHING).body === ORDINARY, "REFUSAL: an ordinary reply is byte-identical");

ok(
  measured.every((c) => c.subject === "access"),
  "SUBJECT: both claims of the measured reply read as ACCESS, including the sentence with no access word in it",
);
const genericOnly = detectRequestClaims("I've submitted the request. It's pending approval.");
ok(genericOnly.length === 2 && genericOnly.every((c) => c.subject === "generic"), "SUBJECT: a reply that names no kind at all reads as GENERIC");

const proseOnly = detectRequestClaims("Your Notion connector is live. I've submitted the request.");
ok(proseOnly.length === 1 && proseOnly[0]?.subject === "generic", "SUBJECT: an access word in prose beside a kind-less claim does NOT make it an access claim");

const ROUTINE_ACK =
  "I've set the one-shot check-in up for 15:00, and a routine-approval card has been raised for the permission it needs.";
const routine = detectRequestClaims(ROUTINE_ACK);
ok(routine.length === 1, `OTHER-KIND: the routine ack still READS as a claim (saw ${routine.length}) — the detector did not simply stop seeing it`);
ok(routine[0]?.shape === "raised", "OTHER-KIND: in the mirror shape the measured audit row named");
ok(routine[0]?.subject === "other-approval", "OTHER-KIND: and it is labelled by the kind ITS OWN sentence names, not by `permission`");
const acked = applyRequestClaimGuard(ROUTINE_ACK, NOTHING);
ok(acked.body === ROUTINE_ACK, "OTHER-KIND: so it posts BYTE-IDENTICAL on a turn with no access propose");
ok(acked.withheld.length === 0, "OTHER-KIND: nothing is withheld, so no row is written and no host note is appended");

const GRANT_NOTE =
  "(No card was raised on this turn. Writes in this room ride a standing grant: notion-rest may PATCH, POST. " +
  "The host sees the policy, not the request, so it cannot say whether this act used it.)";
const MIXED = `${GRANT_NOTE}\n\n${ROUTINE_ACK}`;
const mixed = applyRequestClaimGuard(MIXED, NOTHING);
ok(mixed.body === MIXED, "MIXED: a grant notice beside a routine ack leaves the whole post untouched");
ok(!mixed.body.includes(WITHHELD_REQUEST_CLAIM_NOTE), "MIXED: and the host appends no line answering a claim nobody made");
const mixedClaims = detectRequestClaims(MIXED);
ok(
  mixedClaims.length === 1 && mixedClaims.every((c) => c.subject === "other-approval"),
  `MIXED: the word \`grant\` in the host's own note no longer decides the ack's subject (saw ${mixedClaims.length} claim(s))`,
);

const BOTH = `${ROUTINE_ACK} I've also submitted the channel-scope access request to widen the fixture.`;
const parted = applyRequestClaimGuard(BOTH, NOTHING);
ok(parted.withheld.length === 1, `PARTED: exactly one sentence is withheld (saw ${parted.withheld.length})`);
ok(parted.withheld[0]?.subject === "access", "PARTED: and it is the ACCESS one");
ok(parted.body.includes("routine-approval card has been raised"), "PARTED: the routine ack survives");
ok(!parted.body.includes("channel-scope access request"), "PARTED: the fabricated access claim does not");
ok(parted.body.includes(WITHHELD_REQUEST_CLAIM_NOTE), "PARTED: and the host's line stands in its place");

ok(
  detectRequestClaims("The spend-limit card has been raised for your review.")[0]?.subject === "other-approval",
  "OTHER-KIND: a spend-limit card names its own kind too",
);
ok(
  detectRequestClaims("The connector-write approval card has been raised.")[0]?.subject === "other-approval",
  "OTHER-KIND: and a connector-op card, although `connector` is itself access vocabulary",
);

const LOOSE = "I've submitted the access request to widen the connector so it can file tickets.";
const loose = applyRequestClaimGuard(LOOSE, NOTHING);
ok(loose.withheld.length === 1, `LOOSE: the sentence is still one claim (saw ${loose.withheld.length})`);
ok(loose.withheld[0]?.subject === "access", "LOOSE: a kind word that does not qualify the card leaves it an ACCESS claim");
ok(!loose.body.includes("I've submitted"), "LOOSE: so it is struck");

const TRAILING_KIND = "I've submitted the channel-scope access request for this channel; it's pending routine approval.";
const trailing = applyRequestClaimGuard(TRAILING_KIND, NOTHING);
ok(trailing.withheld.length === 1, `TRAILING-KIND: the sentence is one claim (saw ${trailing.withheld.length})`);
ok(trailing.withheld[0]?.subject === "access", "TRAILING-KIND: a kind qualifying another noun leaves the claim an ACCESS claim");
ok(!trailing.body.includes("I've submitted"), "TRAILING-KIND: so it is struck");
const TRAILING_BARE = "I've submitted the request for POST on `e2e-fixture`; it's pending routine approval.";
ok(detectRequestClaims(TRAILING_BARE)[0]?.subject === "generic", "TRAILING-KIND: a bare span with a kind phrase in another clause stays KIND-LESS");
ok(
  applyRequestClaimGuard(TRAILING_BARE, CARD_MINTED).withheld.length === 1,
  "TRAILING-KIND: so it is struck, and a minted card does not back it either — its own noun is not a card",
);

const TRAILING_SPLIT = "I've submitted the channel-scope request to widen `e2e-fixture` with POST. It's pending routine approval.";
const split = applyRequestClaimGuard(TRAILING_SPLIT, NOTHING);
ok(split.withheld.length === 2, `TRAILING-KIND: split over two sentences, both are withheld (saw ${split.withheld.length})`);

const KINDLESS = "The approval card has been raised, and it is with a reviewer now.";
ok(detectRequestClaims(KINDLESS)[0]?.subject === "generic", "KIND-LESS: a card sentence that names no kind reads as GENERIC");
ok(applyRequestClaimGuard(KINDLESS, NOTHING).withheld.length === 1, "KIND-LESS: with no propose and no card observed it is struck");
ok(applyRequestClaimGuard(KINDLESS, CARD_MINTED).body === KINDLESS, "KIND-LESS: a card the host saw minted backs it, BYTE-IDENTICAL");

const accessVsCard = applyRequestClaimGuard(SHIP_228_REPLY, CARD_MINTED);
ok(accessVsCard.withheld.length === 2, "KIND-LESS: a minted card backs NEITHER sentence of the measured access fabrication");
ok(accessVsCard.body.includes(WITHHELD_REQUEST_CLAIM_NOTE), "KIND-LESS: the host's own line still stands in their place");

const NOT_A_CARD = "I've raised the request with the admins.";
ok(detectRequestClaims(NOT_A_CARD)[0]?.subject === "generic", "KIND-LESS: a request sentence that names no kind also reads as GENERIC");
ok(applyRequestClaimGuard(NOT_A_CARD, CARD_MINTED).withheld.length === 1, "KIND-LESS: but a minted card does NOT back it — its own noun is not a card");
const SPLIT_GENERIC = "I've submitted the request for `e2e-fixture` to POST here. It's pending the required approval.";
ok(
  applyRequestClaimGuard(SPLIT_GENERIC, CARD_MINTED).withheld.length === 2,
  "KIND-LESS: nor an access fabrication written with no access word in it",
);

const EVERY_SUBJECT = `${SHIP_228_REPLY} ${ROUTINE_ACK} ${KINDLESS}`;
const everySubject = applyRequestClaimGuard(EVERY_SUBJECT, NOTHING);
ok(everySubject.withheld.length === 3, `ROW: the mixed body withholds its three unbacked claims (saw ${everySubject.withheld.length})`);
ok(
  everySubject.withheld.every((c) => c.subject !== "other-approval"),
  "ROW: and no `other-approval` claim is ever among them, so the row's subjects stay {access, generic}",
);

await auditWithheldRequestClaim(
  {
    org: "acme",
    platform: "slack",
    workspace: "T1",
    surface: "D0EXDMCH001",
    principalId: "U1",
    turnId: "turn_0",
    sessionId: "wrun_1",
    wakeId: "wake-1",
    route: "tool",
  },
  "slack",
  struck.withheld,
);
const rows = (await readAudit({ org: "acme", limit: 50 })).filter((r) => r.action === REQUEST_CLAIM_WITHHELD_ACTION);
ok(rows.length === 1, `ROW: exactly one ${REQUEST_CLAIM_WITHHELD_ACTION} row (saw ${rows.length})`);
const detail = (rows[0]?.detail ?? {}) as Record<string, unknown>;
ok(detail.claims === 2, "ROW: it counts the claims");
ok(Array.isArray(detail.shapes) && (detail.shapes as string[]).includes("submitted"), "ROW: it names the SHAPE");
ok(Array.isArray(detail.subjects) && (detail.subjects as string[]).includes("access"), "ROW: and the subject");
ok(Array.isArray(detail.sentences) && (detail.sentences as number[]).includes(0), "ROW: and the sentence position");
const serialised = JSON.stringify(rows[0]);
ok(!serialised.includes("e2e-run-muavvcxo"), "ROW: it carries NONE of the struck sentence's text");
ok(!serialised.includes("submitted the channel-scope"), "ROW: nor any fragment of it");

const once = applyRequestClaimGuard(SHIP_228_REPLY, NOTHING).body;
const twice = applyRequestClaimGuard(once, NOTHING).body;
ok(twice.split(WITHHELD_REQUEST_CLAIM_NOTE).length - 1 === 1, "IDEMPOTENT: a second pass still carries exactly one note");
ok(twice.includes(WITHHELD_REQUEST_CLAIM_NOTE), "IDEMPOTENT: and does not quietly drop it while the turn still has no propose");
const healed = applyRequestClaimGuard(once, PROPOSED).body;
ok(!healed.includes(WITHHELD_REQUEST_CLAIM_NOTE), "IDEMPOTENT: a turn that DID propose takes the note back off");

const notedCard = `${KINDLESS}\n\n${WITHHELD_REQUEST_CLAIM_NOTE}`;
ok(
  !applyRequestClaimGuard(notedCard, CARD_MINTED).body.includes(WITHHELD_REQUEST_CLAIM_NOTE),
  "IDEMPOTENT: a claim that survives on the card signal takes the note off with it",
);
ok(
  applyRequestClaimGuard(notedCard, NOTHING).body.includes(WITHHELD_REQUEST_CLAIM_NOTE),
  "IDEMPOTENT: and with nothing observed the claim is struck and the note stands — the negative control for it",
);
const notedAck = `${ROUTINE_ACK}\n\n${WITHHELD_REQUEST_CLAIM_NOTE}`;
ok(applyRequestClaimGuard(notedAck, NOTHING).body === notedAck, "IDEMPOTENT: a routine ack under an earlier note is stable, and keeps exactly one note");

inSession(() => {
  noteAccessRequestProposed("turn_3", ACCESS_REQUEST_KIND, "card-posted");
  const mine = accessRequestsProposedThisTurn("turn_3");
  ok(mine.length === 1, `LEDGER: the write is readable back under its own turn (saw ${mine.length})`);
  ok(mine[0]?.kind === ACCESS_REQUEST_KIND && mine[0]?.outcome === "card-posted", "LEDGER: and carries the kind and the outcome it was given");
  ok(accessRequestsProposedThisTurn("turn_4").length === 0, "LEDGER: another turn reads empty — the key is the turn, not the session");
  noteAccessRequestProposed("turn_5", ACCESS_REQUEST_KIND, "already-pending");
  ok(accessRequestsProposedThisTurn("turn_5")[0]?.outcome === "already-pending", "LEDGER: the deduped arm records its own outcome");
  ok(accessRequestsProposedThisTurn("turn_3").length === 0, "LEDGER: and a turn change drops the previous turn's proposals");
  noteAccessRequestProposed(undefined, ACCESS_REQUEST_KIND, "card-posted");
  ok(accessRequestsProposedThisTurn("").length === 0, "LEDGER: a write with no turn id records nothing");
});

noteAccessRequestProposed("turn_3", ACCESS_REQUEST_KIND, "card-posted");
ok(accessRequestsProposedThisTurn("turn_3").length === 0, "LEDGER: outside an eve context it observes nothing");
ok(accessRequestsProposedThisTurn(undefined).length === 0, "LEDGER: an unreadable turn id answers empty");
ok(ACCESS_REQUEST_KIND === "access.request", "LEDGER: the kind is the approvals plane's own spelling");

const DOOR_AUDIT = {
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C0EXGENRL",
  principalId: "U1",
  turnId: "turn_9",
  sessionId: "wrun_9",
  route: "tool",
} as const;
inSession(() => {
  const before = guardRequestClaims(KINDLESS, DOOR_AUDIT);
  ok(before.withheld.length === 1, `SIGNAL: with no propose and no card, the door step strikes the kind-less claim (saw ${before.withheld.length})`);
  markCardPostedThisTurn();
  const after = guardRequestClaims(KINDLESS, DOOR_AUDIT);
  ok(after.body === KINDLESS && after.withheld.length === 0, "SIGNAL: once the host has minted a card, the same sentence survives byte-identical");
  ok(guardRequestClaims(SHIP_228_REPLY, DOOR_AUDIT).withheld.length === 2, "SIGNAL: the minted card backs neither sentence of the access fabrication");
  ok(guardRequestClaims(ROUTINE_ACK, DOOR_AUDIT).body === ROUTINE_ACK, "SIGNAL: and the routine ack rides no signal at all");
});

const chanDir = join(fileURLToPath(new URL("..", import.meta.url)), "agent", "channels");
const doors = readdirSync(chanDir)
  .filter((n) => n.endsWith(".ts"))
  .filter((n) => readFileSync(join(chanDir, n), "utf-8").includes("applyReplyProvenance("))
  .filter((n) => n !== "reply-provenance.ts");
ok(doors.length >= 3, `PARITY: the door scan found the reply doors (${doors.length}) — an empty scan proves nothing`);
for (const door of ["reply-post.ts", "unified-reply.ts", "reply-edit.ts"]) {
  ok(doors.includes(door), `PARITY: the scan sees the known door ${door} — a scan that missed it would pass vacuously`);
}
const unguarded = doors.filter((n) => !readFileSync(join(chanDir, n), "utf-8").includes("guardRequestClaims("));
ok(unguarded.length === 0, `PARITY: every reply door that foots provenance also runs the request-claim guard — unguarded: ${unguarded.join(", ")}`);
const unaudited = doors.filter((n) => !readFileSync(join(chanDir, n), "utf-8").includes("auditWithheldRequestClaim("));
ok(unaudited.length === 0, `PARITY: and every one of them writes the row — unaudited: ${unaudited.join(", ")}`);

const toolSrc = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "agent", "tools", "request_access.ts"), "utf-8");
ok(
  toolSrc.includes('noteAccessRequestProposed(currentTurnId(ctx), ACCESS_REQUEST_KIND, posted.deduped ? "already-pending" : "card-posted")'),
  "PARITY: request_access arms the ledger on the card arm, telling a fresh card from a deduped one",
);
ok(
  toolSrc.includes('noteAccessRequestProposed(currentTurnId(ctx), ACCESS_REQUEST_KIND, "auto-approved")'),
  "PARITY: and on the chain-lowered arm, which posts no card",
);
ok(!toolSrc.includes("readTurnClock"), "PARITY: the propose site keys the turn off currentTurnId(ctx), never a second clock");

ok(/IN A DIRECT MESSAGE A CHANNEL-SCOPE ASK IS NOT ACTIONABLE/.test(toolSrc), "EXPOSURE: the description states that a DM cannot raise a channel-scope ask");
ok(/raised IN THE CHANNEL and never from a DM/.test(toolSrc), "EXPOSURE: and names the road — the channel itself");
ok(/only a channel-scope ask has to move to the channel/.test(toolSrc), "EXPOSURE: only the CHANNEL universe is said to move");
ok(!/is the only universe a DM can widen/.test(toolSrc), "EXPOSURE: and the description does not deny the group ask the code admits");

await removeTempDir(tmp);
console.log(`request claim guard: ${passed} assertions passed`);
