import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  isUnresumableSessionError,
  unresumableAuditDetail,
  UNREADABLE_WORLD_MESSAGE,
  SLOT_NUMBERED_MARKER,
  WORLD_CONTRACT_ERROR_CODE,
} from "../agent/channels/session-resume.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);

const REAL_MESSAGE =
  "Event id is not slot-numbered: evnt_01K2S7QW8VZ3YB4H9MJXNPRTCD. This World allocates event positions the runtime cannot read.";

{
  ok(isUnresumableSessionError(REAL_MESSAGE), "positive: the verbatim eve unreadable-World message classifies unresumable");
  ok(
    isUnresumableSessionError(`Error while running workflow: ${REAL_MESSAGE}\n    at op (/var/task/runtime.js:1:1)`),
    "positive: the same message wrapped in a stack/prefix still classifies (substring match, not equality)",
  );
  ok(isUnresumableSessionError("anything at all", WORLD_CONTRACT_ERROR_CODE), "positive: eve's WORLD_CONTRACT_ERROR code alone classifies unresumable");
  ok(isUnresumableSessionError("", WORLD_CONTRACT_ERROR_CODE), "positive: the code wins even when the message is empty (the code is checked first)");
}

{
  const transients: readonly string[] = [
    "Transient world error during replay; redelivering via queue instead of failing the run",
    "transient network blip",
    "fetch failed",
    "socket hang up",
    "ETIMEDOUT",
    "AI_APICallError: Gateway timeout",
    "upstream returned 503",
    "EmptyModelResponse",
  ];
  for (const m of transients) {
    ok(isUnresumableSessionError(m) === false, `negative (transient): ${JSON.stringify(m)} classifies FALSE`);
  }

  for (const m of ["SESSION_TOKEN_LIMIT_REACHED", "This session reached its configured input token limit"]) {
    ok(isUnresumableSessionError(m) === false, `negative (session limit): ${JSON.stringify(m)} classifies FALSE`);
  }

  ok(
    isUnresumableSessionError("This World allocates event positions the runtime cannot read") === false,
    "negative (half-match): the World sentence WITHOUT the slot marker classifies FALSE",
  );
  ok(
    isUnresumableSessionError("Event id is not slot-numbered: evnt_123") === false,
    "negative (half-match): the slot marker WITHOUT the World sentence classifies FALSE",
  );
  ok(isUnresumableSessionError("the World is a stage") === false, "negative: a bare mention of 'World' classifies FALSE");
  ok(isUnresumableSessionError("slot 7 is busy") === false, "negative: a bare mention of a slot classifies FALSE");

  ok(isUnresumableSessionError("") === false, "negative: the empty message classifies FALSE");
  for (const v of [undefined, null, 0, 1, {}, [], REAL_MESSAGE.length] as readonly unknown[]) {
    ok(isUnresumableSessionError(v) === false, `negative (shape): ${JSON.stringify(v) ?? "undefined"} classifies FALSE`);
  }
  ok(isUnresumableSessionError("harmless", 500) === false, "negative: a numeric code classifies FALSE");
  ok(isUnresumableSessionError("harmless", "AI_APICallError") === false, "negative: an unrelated string code classifies FALSE");
}

{
  eq(unresumableAuditDetail(REAL_MESSAGE), { unresumable: true }, "detail: a matching message labels unresumable=true");
  eq(unresumableAuditDetail("transient network blip"), { unresumable: false }, "detail: a transient labels unresumable=FALSE — present, not absent");
  eq(unresumableAuditDetail(undefined), { unresumable: false }, "detail: a missing message still emits the boolean");
  ok("unresumable" in unresumableAuditDetail("anything"), "detail: the key is always present (absent must never be readable as 'not measured')");
}

{
  const require = createRequire(import.meta.url);
  const evePkg = require.resolve("eve/package.json");
  const chunkDir = `${evePkg.slice(0, evePkg.lastIndexOf("/"))}/dist/src/compiled/_chunks/workflow`;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(chunkDir).filter((f: string) => f.endsWith(".js"));
  ok(files.length > 0, "pin: the installed eve dist has compiled workflow chunks to search");
  const haystack = files.map((f: string) => readFileSync(`${chunkDir}/${f}`, "utf8")).join("\n");
  ok(
    haystack.includes(UNREADABLE_WORLD_MESSAGE),
    `pin: UNREADABLE_WORLD_MESSAGE is still present in the installed eve runtime — if this is RED, eve re-worded the message and isUnresumableSessionError no longer matches it`,
  );
  ok(
    haystack.includes(SLOT_NUMBERED_MARKER),
    "pin: SLOT_NUMBERED_MARKER is still present in the installed eve runtime",
  );
  const at = haystack.indexOf(UNREADABLE_WORLD_MESSAGE);
  const eveSentence = haystack.slice(Math.max(0, at - 60), at + UNREADABLE_WORLD_MESSAGE.length);
  ok(
    eveSentence.includes(SLOT_NUMBERED_MARKER),
    "pin: eve still emits BOTH markers in ONE message — the two-marker requirement stays satisfiable",
  );
}

console.log(`✓ session-resume: ${passed} assertions passed`);
