import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-claim-guard-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { applyMemoryClaimGuard, detectDurabilityClaims, auditWithheldMemoryClaim, WITHHELD_CLAIM_NOTE, MEMORY_CLAIM_WITHHELD_ACTION } =
  await import("../agent/channels/memory-claim-guard.js");
const { readAudit } = await import("../agent/audit/audit.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const MEASURED_ACK =
  "Recorded and verified for the team: the OPE121 canary code is *obsidian-30653*. " +
  "The durable note and curated memory index were updated.";

const claims = detectDurabilityClaims(MEASURED_ACK);
ok(claims.length > 0, "the measured ack IS a durability claim — a detector that misses it proves nothing about the defect");

function ackIsPermitted(text: string, memoryWriteRowsThisTurn: number): boolean {
  const guarded = applyMemoryClaimGuard(text, memoryWriteRowsThisTurn > 0);
  return guarded.body === text;
}

ok(!ackIsPermitted(MEASURED_ACK, 0), "CONTRACT: an ack that claims durability with ZERO memory.write rows in the turn is REFUSED");
ok(ackIsPermitted(MEASURED_ACK, 1), "CONTRACT: the same ack with a real memory.write row behind it stands");

const measured = applyMemoryClaimGuard(MEASURED_ACK, false);
ok(measured.withheld.length === 2, `BOTH sentences of the measured ack are withheld (got ${measured.withheld.length})`);
ok(
  JSON.stringify(measured.withheld.map((c) => c.sentence)) === "[0,1]",
  `the withheld sentences are the first and the second (got ${JSON.stringify(measured.withheld.map((c) => c.sentence))})`,
);
ok(!measured.body.includes("Recorded and verified"), "the bare-ack half is struck — it carries no store noun and only the bare-ack pattern reaches it");
ok(!measured.body.includes("curated memory index"), "the index half is struck");

const DRAFT = "I've saved that to the team memory silo. The on-call handle is ONCALL-6225.";
const withheldResult = applyMemoryClaimGuard(DRAFT, false);
ok(withheldResult.withheld.length === 1, "one claim is withheld");
ok(!withheldResult.body.includes("saved that to the team memory silo"), "the claiming sentence is STRUCK from the body");
ok(withheldResult.body.includes("ONCALL-6225"), "the FACT the turn produced still reaches the room — the guard strikes a claim, not an answer");
ok(withheldResult.body.includes(WITHHELD_CLAIM_NOTE), "the host says, in its own voice, that the save is not recorded");
ok(withheldResult.body.split(WITHHELD_CLAIM_NOTE).length === 2, "the note appears exactly once");

const TRIPLE = "Stored in memory. The memory index was updated. I've now remembered it. Here is the answer: 42.";
const triple = applyMemoryClaimGuard(TRIPLE, false);
ok(triple.withheld.length === 3, `all three claims are withheld (got ${triple.withheld.length})`);
ok(triple.body.includes("42"), "the answer survives");
ok(triple.body.split(WITHHELD_CLAIM_NOTE).length === 2, "three claims still produce ONE note");

const audit = {
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  principalId: "U1",
  sessionId: "s-1",
  turnId: "turn_3",
  wakeId: "w-1",
} as unknown as Parameters<typeof auditWithheldMemoryClaim>[0];
await auditWithheldMemoryClaim(audit, "slack", withheldResult.withheld);
const rows = await readAudit({ org: "acme", action: MEMORY_CLAIM_WITHHELD_ACTION });
ok(rows.length === 1, `the withheld claim leaves exactly one row (got ${rows.length})`);
const detail = rows[0]!.detail as Record<string, unknown>;
ok(detail.claims === 1, "the row counts the claims");
ok(Array.isArray(detail.shapes) && (detail.shapes as string[])[0] === "stored", "the row names the claim's SHAPE");
ok(Array.isArray(detail.sentences), "the row names WHICH sentence, so an operator can find it in the posted body");
ok(JSON.stringify(detail).indexOf("team memory silo") === -1, "the row never carries the sentence itself — ids, counts and shapes only");
ok(detail.turnId === "turn_3" && detail.sessionId === "s-1", "the row joins back to its turn and session");

const honest = applyMemoryClaimGuard(DRAFT, true);
ok(honest.body === DRAFT, "a claim the host DID record passes through byte-identical");
ok(honest.withheld.length === 0, "and nothing is audited as withheld");

const INNOCENT = [
  "I remember you asked about this last week.",
  "Your notes file lives in the team silo — ask an admin for access.",
  "I'll save this once you confirm the wording.",
  "I'm writing it down now; the save completes with this turn.",
  "That will be stored in memory at the end of the turn.",
  "The deploy is recorded in the release notes on GitHub.",
  "Nothing to report — the build is green.",
  "The OPE121 canary code is obsidian-30653, recorded in the team memory file.",
  "The memory index will be refreshed tonight.",
  "The team silo is going to be updated tomorrow.",
  "Nothing is stored in memory yet.",
  "I have not saved anything to memory.",
  "The memory file was not updated.",
  "Recorded in the release notes on GitHub.",
  "Noted — tonight's on-call handle is ONCALL-6225, from Ana",
  "recorded in soak-brain/standing.md#L2.",
];
for (const text of INNOCENT) {
  const r = applyMemoryClaimGuard(text, false);
  ok(r.body === text && r.withheld.length === 0, `an ordinary reply is untouched: "${text}"`);
}

ok(applyMemoryClaimGuard("I'll save this to memory.", false).withheld.length === 0, "a FUTURE claim stands — it is the honest sentence");
ok(applyMemoryClaimGuard("I saved this to memory.", false).withheld.length === 1, "the PAST claim of the same act is withheld");

const once = applyMemoryClaimGuard(DRAFT, false);
const twice = applyMemoryClaimGuard(once.body, false);
ok(twice.body.split(WITHHELD_CLAIM_NOTE).length === 2, "a second pass over an already-guarded body leaves ONE note, not two");
const cleared = applyMemoryClaimGuard(once.body, true);
ok(!cleared.body.includes(WITHHELD_CLAIM_NOTE), "a later pass with the write recorded takes the note back off");

const chanDir = join(fileURLToPath(new URL("..", import.meta.url)), "agent", "channels");
const doors = readdirSync(chanDir)
  .filter((n) => n.endsWith(".ts"))
  .filter((n) => readFileSync(join(chanDir, n), "utf-8").includes("applyReplyProvenance("))
  .filter((n) => n !== "reply-provenance.ts");
ok(doors.length >= 3, `the door scan found the reply doors (${doors.length}) — an empty scan proves nothing`);
for (const door of ["reply-post.ts", "unified-reply.ts", "reply-edit.ts"]) {
  ok(doors.includes(door), `the scan sees the known door ${door} — a scan that missed it would pass vacuously`);
}
const unguarded = doors.filter((n) => !readFileSync(join(chanDir, n), "utf-8").includes("guardMemoryClaims("));
ok(unguarded.length === 0, `PARITY: every reply door that foots provenance also runs the claim guard — unguarded: ${unguarded.join(", ")}`);

rmSync(tmp, { recursive: true, force: true });
console.log(`memory claim guard: ${passed} assertions passed`);
