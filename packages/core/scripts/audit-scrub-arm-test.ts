import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-audit-scrub-arm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

import { auditErrorDetail } from "../agent/audit/tool-action.js";
import { registerConfig, type AppConfig } from "../agent/access/config.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const BUILT_IN_SHAPE = "sk-live-abcdefghijklmnop";
const CONSUMER_SHAPE = "ACME-KEY-abcdefghijklmnop";
const MESSAGE = `upstream refused: token ${BUILT_IN_SHAPE} and ${CONSUMER_SHAPE} rejected`;

function config(auditScrub?: (text: string) => string): AppConfig {
  return {
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    ...(auditScrub ? { auditScrub } : {}),
  };
}

const noConfigAtAll = auditErrorDetail(new Error(MESSAGE)).error;
ok(
  !noConfigAtAll.includes(BUILT_IN_SHAPE) && noConfigAtAll.includes("[redacted]"),
  "no app config registered at all: the built-in arm still scrubs (getConfig()'s throw is read as 'no arm', not as a failure)",
);
ok(
  noConfigAtAll.includes(CONSUMER_SHAPE),
  "no app config registered: a shape the built-in does not know is NOT redacted (negative control — the built-in is not secretly redacting everything)",
);

registerConfig(config());
const noArm = auditErrorDetail(new Error(MESSAGE)).error;
eq(
  noArm,
  noConfigAtAll,
  "a config with NO auditScrub arm is byte-identical to no config at all — absence of a drop-in IS the built-in (this deployment registers none)",
);

registerConfig(config((text) => text.replaceAll(CONSUMER_SHAPE, "[redacted]")));
const added = auditErrorDetail(new Error(MESSAGE)).error;
ok(
  !added.includes(CONSUMER_SHAPE),
  "a consumer arm ADDS a redaction the built-in does not know (the ACME- family this fictional deployment holds)",
);
ok(
  !added.includes(BUILT_IN_SHAPE),
  "a consumer arm that adds a redaction does not disturb the built-in's own — both shapes are struck",
);
ok(
  noArm.includes(CONSUMER_SHAPE),
  "negative control for the line above: the SAME input keeps the ACME- shape when no arm is registered, so the arm is what struck it",
);

let armSaw: string | undefined;
registerConfig(
  config((text) => {
    armSaw = text;
    return text;
  }),
);
const passthrough = auditErrorDetail(new Error(MESSAGE)).error;
ok(armSaw !== undefined, "the registered arm is actually CALLED (without this, every add-only claim below is vacuous)");
ok(
  armSaw!.includes("[redacted]") && !armSaw!.includes(BUILT_IN_SHAPE),
  "the arm is handed the ALREADY-SCRUBBED text: it sees '[redacted]' and never the built-in-struck secret",
);
eq(
  passthrough,
  noArm,
  "for THIS fixture, a pass-through arm leaves the built-in result exactly as it was — fixture-scoped on purpose, not a law: the extra built-in pass is monotone, not idempotent (see 2e)",
);

registerConfig(config((text) => text.replaceAll("[redacted]", BUILT_IN_SHAPE)));
const restoreAttempt = auditErrorDetail(new Error(MESSAGE)).error;
ok(
  !restoreAttempt.includes(BUILT_IN_SHAPE),
  "an arm that writes a built-in credential shape into its output CANNOT get it into the audit row — the built-in re-runs over the arm's output as a floor",
);
ok(
  restoreAttempt.includes("[redacted]"),
  "and what the arm wrote lands as a redaction, not as a hole — the row still says a credential was struck",
);

registerConfig(config((text) => `${text} and the arm appended this`));
const appended = auditErrorDetail(new Error(MESSAGE)).error;
ok(
  appended.includes("and the arm appended this"),
  "an arm CAN add non-secret text to an audit row — the seam constrains what SURVIVES, not what an arm may write",
);
registerConfig(config(() => "the arm replaced the whole message"));
eq(
  auditErrorDetail(new Error(MESSAGE)).error,
  "the arm replaced the whole message",
  "an arm CAN replace the message wholesale — the same limit, stated honestly",
);

registerConfig(config((text) => text));
const doubleScrubbed = auditErrorDetail(new Error("AKIA123456789012bearer aaaaaaaa")).error;
eq(
  doubleScrubbed,
  "[redacted][redacted]",
  "the second built-in pass can strike MORE than the first (the ']' supplies the word boundary the Bearer shape needs) — monotone, not idempotent",
);
ok(
  !doubleScrubbed.includes("AKIA123456789012"),
  "and the extra pass only ever redacts: no text the first pass struck comes back",
);

registerConfig(
  config(() => {
    throw new Error("this consumer arm is broken");
  }),
);
const threwDetail = auditErrorDetail(new Error(MESSAGE));
eq(threwDetail.error, noArm, "a THROWING arm leaves the built-in's result standing, byte for byte (fail-closed to the built-in)");
ok(
  !threwDetail.error.includes(BUILT_IN_SHAPE),
  "a throwing arm does not cost the built-in its redaction — the secret is still struck",
);

registerConfig(config((text) => `${text}\nthe arm added\ta second line`));
const rowy = auditErrorDetail(new Error(MESSAGE)).error;
ok(rowy.includes("the arm added a second line"), "positive control: the arm's text IS in the row, so the next assertion cannot pass with the arm uncalled");
ok(!rowy.includes("\n") && !rowy.includes("\t"), "an arm cannot widen an audit row: its output still passes the whitespace collapse");

registerConfig(config((text) => text + "x".repeat(1000)));
const long = auditErrorDetail(new Error(MESSAGE)).error;
ok(long.length > noArm.length, "positive control: the padding arm DID lengthen the text, so the cap below is a real bound and not the no-arm row passing by default");
ok(long.length <= 301, "an arm cannot lengthen an audit row past the 300-char cap (+ the ellipsis) — truncation runs after the arm");

registerConfig(config());

console.log(`✓ audit-scrub arm: ${n} assertions passed`);
