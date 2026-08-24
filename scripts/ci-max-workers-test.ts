import { ciMaxWorkersOverride } from "./ci-max-workers.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(ciMaxWorkersOverride({}) === undefined, "no OE_IT_CI_MAX_WORKERS set — undefined, so the caller's local default (2) applies");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "" }) === undefined, "an empty string is treated as unset");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "   " }) === undefined, "a blank (whitespace-only) value is treated as unset");

ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "3" }) === 3, "OE_IT_CI_MAX_WORKERS=3 overrides to 3");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "4" }) === 4, "OE_IT_CI_MAX_WORKERS=4 overrides to 4");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "1" }) === 1, "OE_IT_CI_MAX_WORKERS=1 overrides to 1 (a degenerate but valid value)");

ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "0" }) === undefined, "0 is rejected — a worker count of 0 would hang the tier");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "-1" }) === undefined, "a negative value is rejected");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "2.5" }) === undefined, "a non-integer value is rejected");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "nope" }) === undefined, "a non-numeric value is rejected, not coerced to NaN");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "3abc" }) === undefined, "a value Number() cannot fully parse is rejected");

console.log(
  `✓ ci-max-workers: ${passed} assertions passed (unset/blank falls back to the local default, valid integers pass through, ` +
    `every malformed shape — 0, negative, non-integer, non-numeric — is rejected rather than coerced).`,
);
