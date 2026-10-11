import assert from "node:assert/strict";
import { BASELINE, rawIdHits, verdicts } from "./friendly-ids-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const count = (line: string): number => rawIdHits("x.ts", line).length;

ok(count("    `\\n\\n_Sent by the agent on behalf of ${input.requestedBy}, from ${input.fromContainer}. ` +") === 2, "the old footer line counts both raw fields");
ok(count("  return `Requested by ${args.requestedBy}`;") === 1, "a requester id in prose counts");
ok(count("  const s = `spend key ${JSON.stringify(principalId)} is wrong`;") === 1, "a raw id wrapped in JSON.stringify still counts (it prints the id in quotes)");
ok(count("  const s = `opened by ${ctx.actorId} just now`;") === 1, "an actor id counts");
ok(count("  const s = `in ${row.channelId} today`;") === 1, "a channel id counts");
ok(count("    `Target: ${args.routineSurfaceKey}`,") === 1, "🔴 a compound name ending in a raw field counts (routineSurfaceKey)");
ok(count("  const s = `owner ${ask.ownerPrincipalId} here`;") === 1, "…and so does ownerPrincipalId");

ok(count("  return `Requested by <@${args.requestedBy}>`;") === 0, "a platform mention is not counted");
ok(count("  return `Requested by ${requesterWords(args.requestedBy, args.scopeKey)}`;") === 0, "a renderer call is not counted");
ok(count("  return `Target: ${placeWords({ key: args.surfaceKey })}`;") === 0, "placeWords is not counted");
ok(count("  console.log(`dropped ${surfaceKey} here`);") === 0, "a console line is not counted");
ok(count("  throw new Error(`no row for ${scopeKey} at all`);") === 0, "a thrown Error is not counted");
ok(count("  slog(`comment on ${surfaceKey} dropped`);") === 0, "a host log helper is not counted");
ok(count("  const key = `${org}:${surfaceKey}`;") === 0, "a key composition with no prose is not counted");
ok(count("  const url = `https://x.example/members/${userId}`;") === 0, "a URL path segment is not counted");
ok(count("  const p = `/v1/members/${userId}`;") === 0, "a bare path segment is not counted");
ok(count("  return `asked by ${platform}/${principalId} today`;") === 1, "🔴 a slash inside PROSE still counts — the live defect's shape");
ok(count("  return `from slack/${workspace}/${channelId}.`;") === 1, "…and so does a scope key spelled out in prose");
ok(count("  // a comment naming ${principalId} in prose") === 0, "a comment is not counted");

const hit = { file: "a.ts", line: 1, text: "x" };
ok(verdicts(new Map([["a.ts", [hit]]]), {}).length === 1, "a file with a hit and no baseline fails");
ok(verdicts(new Map([["a.ts", [hit]]]), { "a.ts": { count: 1, why: "w" } }).length === 0, "a file at its baseline passes");
ok(verdicts(new Map([["a.ts", [hit, hit]]]), { "a.ts": { count: 1, why: "w" } }).length === 1, "a file over its baseline fails");
ok(verdicts(new Map(), { "a.ts": { count: 1, why: "w" } }).length === 1, "a file UNDER its baseline fails, so a fixed line cannot be re-spent");
ok(Object.values(BASELINE).every((e) => e.count > 0 && e.why.length > 0), "every baseline entry has a count and a reason");

console.log(`✓ friendly-ids-lint: ${n} assertions passed`);
