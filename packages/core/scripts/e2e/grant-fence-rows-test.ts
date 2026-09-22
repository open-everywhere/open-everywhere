import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import { currentDomainScopeKey, isSessionGrantRow } from "./grant-fence-rows.js";

const SESSION = "wrun_session_this_run";
const OTHER = "wrun_session_other_room";
const DOMAIN = "oe-grant-domain::e2e-unified";

const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
  ts: "2026-01-27T10:30:43.000Z",
  org: "default",
  platform: "discord",
  workspace: "e2e",
  action,
  detail,
});

const refusedHere = row("grant.refused", { gate: "grant_already_live", scopeKey: SESSION, domainScopeKey: DOMAIN });
const askedHere = row("grant.asked", { connector: "notion", scopeKey: SESSION, domainScopeKey: DOMAIN });
const refusedOther = row("grant.refused", { gate: "grant_already_live", scopeKey: OTHER, domainScopeKey: DOMAIN });
const askedOther = row("grant.asked", { connector: "notion", scopeKey: OTHER, domainScopeKey: DOMAIN });
const wrongAction = row("grant.granted", { scopeKey: SESSION, domainScopeKey: DOMAIN });
const noScope = row("grant.refused", { gate: "grant_already_live" });

assert.equal(isSessionGrantRow(refusedHere, SESSION), true);
assert.equal(isSessionGrantRow(askedHere, SESSION), true);
assert.equal(isSessionGrantRow(refusedOther, SESSION), false);
assert.equal(isSessionGrantRow(askedOther, SESSION), false);
assert.equal(isSessionGrantRow(wrongAction, SESSION), false);
assert.equal(isSessionGrantRow(noScope, SESSION), false);
assert.equal(isSessionGrantRow(row("grant.refused", { scopeKey: "" }), ""), false);

const lateWindow = [refusedOther, refusedHere];
assert.equal(lateWindow.some((e) => isSessionGrantRow(e, SESSION)), true);
assert.equal(currentDomainScopeKey(lateWindow, SESSION), DOMAIN);
const earlyWindow = [refusedOther];
assert.equal(earlyWindow.some((e) => isSessionGrantRow(e, SESSION)), false);
assert.equal(currentDomainScopeKey(earlyWindow, SESSION), undefined);

console.log("grant-fence-rows-test: isSessionGrantRow — 11 assertions passed");
