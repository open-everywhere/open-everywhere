import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proofContent, PROOF_CONTENT_EMPTY, PROOF_CONTENT_REDACTED } from "../deploy/discord-relay/proof-log.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

{
  const SECRET_TEXT = "the quarterly numbers are 4.2m";

  ok("shipping OFF: the PROOF line carries the message text", proofContent(SECRET_TEXT, false) === SECRET_TEXT);

  const shipped = proofContent(SECRET_TEXT, true);
  ok("shipping ON: the PROOF line carries the redaction marker", shipped === PROOF_CONTENT_REDACTED);
  ok("shipping ON: no part of the message text survives", !shipped.includes(SECRET_TEXT) && !shipped.includes("4.2m") && !shipped.includes("quarterly"));

  ok("the two arms differ", proofContent(SECRET_TEXT, false) !== proofContent(SECRET_TEXT, true));
  ok("shipping OFF never redacts", proofContent("hello", false) === "hello");

  for (const [label, shipping] of [
    ["shipping OFF", false],
    ["shipping ON", true],
  ] as const) {
    ok(`${label}: empty content reports the intent diagnostic`, proofContent("", shipping) === PROOF_CONTENT_EMPTY);
    ok(`${label}: undefined content reports the intent diagnostic`, proofContent(undefined, shipping) === PROOF_CONTENT_EMPTY);
  }

  ok("the redaction marker names the variable that caused it", PROOF_CONTENT_REDACTED.includes("OE_LOG_SHIP_URL"));
}

{
  const src = readFileSync(join(REPO_ROOT, "deploy/discord-relay/index.js"), "utf-8");

  ok("index.js imports the seam", /from\s+"\.\/proof-log\.js"/.test(src) && src.includes("proofContent"));

  ok(
    "the message content reaches the seam, with LOG_SHIP_URL as the arm",
    /proofContent\(\s*message\.content\s*,[^)]*LOG_SHIP_URL/.test(src),
  );
  ok("…and no call hard-codes the arm", !/proofContent\([^)]*,\s*(?:true|false)\s*\)/.test(src));

  const consoleCalls: string[] = [];
  for (const m of src.matchAll(/console\.(?:log|warn|error)\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    consoleCalls.push(src.slice(m.index, i + 1));
  }
  ok("the scan found the console calls it is meant to cover", consoleCalls.length >= 5);
  ok("no console call carries message.content", consoleCalls.every((c) => !c.includes("message.content")));

  const contentReads = [...src.matchAll(/message\.content/g)].length;
  ok("message.content is read exactly twice", contentReads === 2);
  ok("…once into the seam", /proofContent\(\s*message\.content/.test(src));
  ok("…and once as the FORWARD payload field", /content:\s*message\.content,/.test(src));

  const dockerfile = readFileSync(join(REPO_ROOT, "deploy/discord-relay/Dockerfile"), "utf-8");
  ok("the Dockerfile copies proof-log.js beside index.js", /^COPY .*\bproof-log\.js\b.*$/m.test(dockerfile));

  const readme = readFileSync(join(REPO_ROOT, "deploy/discord-relay/README.md"), "utf-8");
  ok("the README's PROOF section states the log-shipping combination", readme.includes("OE_LOG_SHIP_URL") && readme.includes(PROOF_CONTENT_REDACTED));
}

console.log(`✓ discord-relay proof line: ${n} assertions passed`);
