// proves: approval.claim_withheld

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-approval-claim-guard-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const {
  applyApprovalClaimGuard,
  detectNoApprovalClaims,
  standingAuthorityNote,
  auditWithheldApprovalClaim,
  APPROVAL_CLAIM_WITHHELD_ACTION,
  NO_CARD_NOTE_OPENING,
} = await import("../agent/channels/approval-claim-guard.js");
const { describeStandingWriteGrant } = await import("../agent/channels/standing-authority.js");
const { openWriteHosts } = await import("../agent/access/egress.js");
const { readAudit } = await import("../agent/audit/audit.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    return;
  }
  passed++;
}

const NOTION_REST_GRANT = { host: "api.notion.com", credential: "notion-rest", verb: ["GET", "PATCH", "POST"] as readonly string[] } as const;
const GRANT_VIEW = { approvalGateRan: false, gatedWrites: [], grants: [NOTION_REST_GRANT] };

const MEASURED_Ra_REPLY =
  "The Notion page was created and verified: • *Title:* `OE tier ctwrite-53128` • *Body:* " +
  "`ctwrite-53128` • *Link:* <https://app.notion.com/p/OE-tier-ctwrite-53128-40000000000040008000000000000108|Open in Notion> " +
  "No confirmation or approval requirement was presented.";

const guarded = applyApprovalClaimGuard(MEASURED_Ra_REPLY, GRANT_VIEW);
ok(guarded.withheld.length === 1, `CONTRACT: the measured reply's no-approval claim is struck (struck ${guarded.withheld.length})`);
ok(guarded.withheld[0]?.shape === "none-presented", `CONTRACT: it is struck as the "none-presented" shape (got ${guarded.withheld[0]?.shape})`);
ok(
  !guarded.body.includes("No confirmation or approval requirement was presented"),
  "CONTRACT: the false-security sentence does NOT reach the room",
);
ok(guarded.body.includes(NO_CARD_NOTE_OPENING), "CONTRACT: the host's own line replaces it");
ok(!guarded.body.includes("notion-rest"), "🔴 CONTRACT (OPE-2487): the line does NOT name the credential id — that is the plane's word, not the room's");
ok(guarded.body.includes("api.notion.com"), "CONTRACT: the line NAMES the host the grant reaches");
ok(guarded.body.includes("ctwrite-53128"), "CONTRACT: the run token the room asked for SURVIVES the strike");
ok(guarded.body.includes("app.notion.com/p/OE-tier-ctwrite-53128"), "CONTRACT: the page link SURVIVES the strike");
ok(guarded.cause === "standing-write-grant", `CONTRACT: the cause is named for the row (got ${guarded.cause})`);
ok(
  guarded.body.includes("standing permission to make changes in api.notion.com") && guarded.body.includes("may have used it"),
  "CONTRACT: the line says what stands in this room and admits it cannot say what ran",
);
ok(!/\bcovered\b/i.test(guarded.body), "CONTRACT: and never tells the room this particular act was covered");
ok(!/\b(?:GET|POST|PATCH|PUT|DELETE)\b/.test(guarded.body), "🔴 CONTRACT (OPE-2487): the line names no HTTP verb — the place is enough for the room");
ok(!/\b(?:grant|gate|ungated)\b/i.test(guarded.body.slice(guarded.body.indexOf(NO_CARD_NOTE_OPENING))), "🔴 CONTRACT (OPE-2487): the host's line uses no plane vocabulary (grant, gate, ungated)");

const claimOnly = "I created the page. No approval was required.";

const cardArm = applyApprovalClaimGuard(claimOnly, { approvalGateRan: true, gatedWrites: [], grants: [] });
ok(cardArm.cause === "approval-gate-ran", "CAUSE: an approval gate that ran this turn contradicts the claim outright");
ok(cardArm.body.includes("(This needs an approval, or already has one.)"), "CAUSE: and the line says only what the signal proves — an approval path ran, never that the act was approved or that a card is in the room");
ok(detectNoApprovalClaims(cardArm.body).length === 0, "🔴 CAUSE (OPE-2487): the host line makes no no-approval claim of its own");
ok(!cardArm.body.includes("No approval was required"), "CAUSE: the contradicted sentence does not post");

const writeArm = applyApprovalClaimGuard(claimOnly, {
  approvalGateRan: false,
  gatedWrites: [{ connection: "notion", op: "create-pages", tier: "write" }],
  grants: [],
});
ok(writeArm.cause === "gated-connector-write", "CAUSE: a completed gated connector write names the standing approval");
ok(writeArm.body.includes("this notion change"), "CAUSE: and the line names the connection");
ok(
  writeArm.body.includes("an approval for this notion change was already in place"),
  "CAUSE: it says an approval already stood — the one thing common to a session grant, a routine lift and the blanket memo",
);

const allThree = applyApprovalClaimGuard(claimOnly, {
  approvalGateRan: true,
  gatedWrites: [{ connection: "notion", op: "create-pages", tier: "write" }],
  grants: [NOTION_REST_GRANT],
});
ok(allThree.cause === "approval-gate-ran", "CAUSE: a gate that ran outranks the other two — it contradicts the claim rather than explaining it");

const noCause = applyApprovalClaimGuard(MEASURED_Ra_REPLY, { approvalGateRan: false, gatedWrites: [], grants: [] });
ok(noCause.body === MEASURED_Ra_REPLY, "SILENT: a turn the host can name no authority for posts BYTE-IDENTICAL");
ok(noCause.withheld.length === 0, "SILENT: and nothing is recorded as withheld");
ok(noCause.cause === undefined, "SILENT: and no cause is named");
const uncredentialed = standingAuthorityNote({ approvalGateRan: false, gatedWrites: [], grants: [] });
ok(uncredentialed === undefined, "SILENT: a view with no card, no write and no grant yields NO note at all");

const honest: readonly [string, string][] = [
  ["Shall I go ahead without confirmation?", "a question OFFERING the gate is not a report about it"],
  ["Do you want me to proceed without approval?", "the same offer in the other wording"],
  ["Publishing that would need your approval first.", "a conditional about a FUTURE act"],
  ["If you want the page public, that will require your approval.", "a plan, guarded by a modal"],
  ["I can do it, but it will not be possible without approval.", "a modal inside the matched span"],
  ["Your approval came through at 14:02.", "an approval noun with no negation is not a claim"],
  ["No pages matched that search.", "a negation with no approval noun is not a claim"],
  ["I have not created anything yet.", "an ordinary admission"],
  ["The deploy is green and the tests pass.", "ordinary prose"],
  ["Consent was not obtained from the vendor, so I stopped.", "a negation that reaches no gate verb"],
  ["Your approval request is not visible to anyone else in the channel.", "a fact about visibility, not about the gate"],
  ["The permission is not the blocker here - the token is expired.", "a fact about the blocker, not about the gate"],
];
for (const [text, why] of honest) {
  const out = applyApprovalClaimGuard(text, GRANT_VIEW);
  ok(out.body === text && out.withheld.length === 0, `FALSE-POSITIVE: "${text}" is left alone — ${why}`);
}

const struckShapes: readonly [string, string][] = [
  ["No approval was required for this.", "none-required"],
  ["No approval card was presented.", "none-presented"],
  ["I created it without any confirmation.", "without-approval"],
  ["Confirmation was not needed here.", "none-required"],
];
for (const [text, shape] of struckShapes) {
  const found = detectNoApprovalClaims(text);
  ok(found.length === 1 && found[0]?.shape === shape, `SHAPE: "${text}" reads as ${shape} (got ${found.map((c) => c.shape).join(",") || "none"})`);
}

const thrice = applyApprovalClaimGuard(
  "Done. No approval was required. No confirmation card was presented. I went ahead without approval.",
  GRANT_VIEW,
);
ok(thrice.withheld.length === 3, `MULTI: all three claiming sentences are struck (struck ${thrice.withheld.length})`);
ok(thrice.body.split(NO_CARD_NOTE_OPENING).length === 2, "MULTI: and ONE note replaces them — three copies would read as a rendering fault");
ok(thrice.body.startsWith("Done."), "MULTI: the non-claiming sentence survives, in its own place");

for (const view of [
  { approvalGateRan: true, gatedWrites: [], grants: [] },
  { approvalGateRan: false, gatedWrites: [{ connection: "notion", op: "create-pages", tier: "write" as const }], grants: [] },
  GRANT_VIEW,
]) {
  const once = applyApprovalClaimGuard(claimOnly, view);
  const twice = applyApprovalClaimGuard(once.body, view);
  ok(twice.body === once.body, `IDEMPOTENT: a second pass over an already-guarded body changes nothing (cause ${once.cause})`);
  ok(twice.withheld.length === 0, `IDEMPOTENT: and finds no claim in the host's own line (cause ${once.cause})`);
}

const WITH_CODE = ['Here is the script:', '```bash', '  if [ -x foo ]; then', '      echo hi', '  fi', '```', 'No approval was required.'].join('\n');
const codeGuarded = applyApprovalClaimGuard(WITH_CODE, GRANT_VIEW);
ok(codeGuarded.withheld.length === 1, 'FORMAT: the claim after a code block is still found');
ok(codeGuarded.body.includes('  if [ -x foo ]; then'), 'FORMAT: and the fenced block keeps its indentation, byte for byte');
ok(codeGuarded.body.includes('      echo hi'), 'FORMAT: including the deeper indent a collapse would have flattened');
const WITH_TABLE = ['| a | b |', '| --- | --- |', '| 1   | 2   |', '', 'No approval was needed for that read.'].join('\n');
const tableGuarded = applyApprovalClaimGuard(WITH_TABLE, GRANT_VIEW);
ok(tableGuarded.body.includes('| 1   | 2   |'), 'FORMAT: a Markdown table keeps its alignment');
ok(tableGuarded.body.includes(NO_CARD_NOTE_OPENING), 'FORMAT: and the note still lands');

const trailing = applyApprovalClaimGuard('I created it. No approval was required, and the link is above.', GRANT_VIEW);
ok(trailing.body.startsWith('I created it.'), 'COST: the sentence before the claim is untouched');
ok(!trailing.body.includes('and the link is above'), 'COST: the clause AFTER the claim goes with it — the documented price');
const auditCtx = {
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  principalId: "U1",
  turnId: "turn_7",
  sessionId: "wrun_1",
  wakeId: "w1",
  route: "tool",
} as const;
await auditWithheldApprovalClaim(auditCtx, "slack", guarded.withheld, guarded.cause);
const rows = (await readAudit({ org: "acme", limit: 50 })).filter((r) => r.action === APPROVAL_CLAIM_WITHHELD_ACTION);
ok(rows.length === 1, `ROW: one ${APPROVAL_CLAIM_WITHHELD_ACTION} row lands (got ${rows.length})`);
const detail = (rows[0]?.detail ?? {}) as Record<string, unknown>;
ok(detail.claims === 1, "ROW: it counts the claims");
ok(detail.cause === "standing-write-grant", "ROW: it names the cause the host put in the claim's place");
ok(Array.isArray(detail.shapes) && (detail.shapes as string[]).includes("none-presented"), "ROW: it names the shape");
ok(
  JSON.stringify(detail.sentences) === JSON.stringify(guarded.withheld.map((c) => c.sentence)),
  `ROW: it names the sentence INDEX the guard struck (got ${JSON.stringify(detail.sentences)})`,
);
{
  const struckIndex = guarded.withheld[0]!.sentence;
  const segment = MEASURED_Ra_REPLY.split(/(?<=[.!?\n])/u);
  ok(
    (segment[struckIndex] ?? "").includes("No confirmation or approval requirement"),
    `ROW: and sentence ${struckIndex} of the original reply is the one that carried the claim`,
  );
}
ok(detail.turnId === "turn_7" && detail.sessionId === "wrun_1", "ROW: it carries the join keys");
const serialised = JSON.stringify(detail);
ok(!serialised.includes("No confirmation or approval requirement"), "ROW: it NEVER carries the struck sentence — model text stays out of the audit plane");
ok(!serialised.includes("ctwrite-53128"), "ROW: nor any other byte of the reply");
await auditWithheldApprovalClaim(auditCtx, "slack", noCause.withheld, noCause.cause);
const afterSilent = (await readAudit({ org: "acme", limit: 50 })).filter((r) => r.action === APPROVAL_CLAIM_WITHHELD_ACTION);
ok(afterSilent.length === 1, "ROW: a reply that kept its text writes no row");

const compiled = openWriteHosts(
  {
    allow: {
      "api.notion.com": [{ match: { method: ["GET", "POST", "PATCH"] }, transform: [{ set: { header: "authorization" } }] }],
      "registry.npmjs.org": [{ match: { method: ["GET"] } }],
    },
  } as never,
  [{ host: "api.notion.com", viaConnection: "notion-rest" }] as never,
);
const notion = compiled.find((h) => h.host === "api.notion.com");
ok(notion !== undefined, "JOIN: openWriteHosts reports the write-capable Notion host");
ok(notion?.credential === "notion-rest", `JOIN: beside the connection id that stamps there (got ${String(notion?.credential)})`);
ok(notion?.credentialed === true, "JOIN: and says a credential rides");
const sentence = describeStandingWriteGrant({ host: notion!.host, credential: notion!.credential!, verb: notion!.verb });
ok(sentence === "api.notion.com", `JOIN: the room-facing place reads "${sentence}"`);
ok(
  compiled.find((h) => h.host === "registry.npmjs.org") === undefined,
  "JOIN: a GET-only host never reaches this plane at all — openWriteHosts drops it, so no reply can name it as a write grant",
);
ok(
  describeStandingWriteGrant({ host: "*.notion.com", credential: "npm", verb: ["GET"] }) === "notion.com",
  "JOIN: a leading wildcard label is dropped from the place",
);
ok(
  describeStandingWriteGrant({ host: "*", credential: "broad", verb: "any" }) === "any service",
  'JOIN: a bare "*" is said in words, never printed as a symbol',
);

const scenarios = readFileSync(fileURLToPath(new URL("./e2e/scenarios.ts", import.meta.url)), "utf-8");
ok(
  scenarios.includes('import { detectNoApprovalClaims, NO_CARD_NOTE_OPENING } from "../../agent/channels/approval-claim-guard.js";'),
  "LEG PIN: S-CONNECTOR-TIER imports the detector and the note opening from the guard",
);
ok(
  scenarios.includes("const ungatedClaims = detectNoApprovalClaims(writeReply.text);") &&
    scenarios.includes("ungatedClaims.length === 0,"),
  "LEG PIN: and its deterministic gate is the detector reading zero claims, the negative the plane enforces",
);
ok(
  !scenarios.includes("/confirm|approv|about to|going to/i.test(writeReply.text)"),
  "LEG PIN: and the keyword gate the measured defect reply would have passed is GONE",
);
ok(
  detectNoApprovalClaims(MEASURED_Ra_REPLY).length === 1,
  "LEG PIN: the leg gate REDS on the exact reply a live run posted — the reply the keyword gate passed",
);
ok(
  !scenarios.includes(`"${NO_CARD_NOTE_OPENING}"`),
  "LEG PIN: and carries no literal copy of the string, which is what would drift",
);

const chanDir = join(fileURLToPath(new URL("..", import.meta.url)), "agent", "channels");
const doors = readdirSync(chanDir)
  .filter((n) => n.endsWith(".ts"))
  .filter((n) => readFileSync(join(chanDir, n), "utf-8").includes("applyReplyProvenance("))
  .filter((n) => n !== "reply-provenance.ts");
ok(doors.length >= 3, `PARITY: the door scan found the reply doors (${doors.length}) — an empty scan proves nothing`);
for (const door of ["reply-post.ts", "unified-reply.ts", "reply-edit.ts"]) {
  ok(doors.includes(door), `PARITY: the scan sees the known door ${door} — a scan that missed it would pass vacuously`);
}
const unguarded = doors.filter((n) => !readFileSync(join(chanDir, n), "utf-8").includes("guardApprovalClaims("));
ok(unguarded.length === 0, `PARITY: every reply door that foots provenance also runs the approval-claim guard — unguarded: ${unguarded.join(", ")}`);
const unaudited = doors.filter((n) => !readFileSync(join(chanDir, n), "utf-8").includes("auditWithheldApprovalClaim("));
ok(unaudited.length === 0, `PARITY: and every one of them writes the row — unaudited: ${unaudited.join(", ")}`);

await removeTempDir(tmp);
console.log(`approval claim guard: ${passed} assertions passed`);
