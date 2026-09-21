import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-request-claim-guard-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const {
  applyRequestClaimGuard,
  detectRequestClaims,
  auditWithheldRequestClaim,
  REQUEST_CLAIM_WITHHELD_ACTION,
  WITHHELD_REQUEST_CLAIM_NOTE,
} = await import("../agent/channels/request-claim-guard.js");
const { accessRequestsProposedThisTurn, noteAccessRequestProposed, ACCESS_REQUEST_KIND } = await import(
  "../agent/channels/access-request-ledger.js"
);
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

const NOTHING = false;
const PROPOSED = true;

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
  "(No card was raised on this turn. A gated notion write ran on it, which means an approval already stood for this session — not that the write is ungated.)",
  "(No durable memory write is recorded for this turn, so I cannot say the note is stored.)",
];
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
ok(genericOnly.length === 2 && genericOnly.every((c) => c.subject === "generic"), "SUBJECT: a reply with no access word reads as GENERIC");

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

rmSync(tmp, { recursive: true, force: true });
console.log(`request claim guard: ${passed} assertions passed`);
