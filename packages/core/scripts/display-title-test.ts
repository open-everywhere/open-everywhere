import assert from "node:assert/strict";
import { displayTitle } from "../agent/identity/display-title.js";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import { friendlyScopeLabel } from "../agent/approvals/scope-label.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(displayTitle({ name: "payments" }) === "payments", "no title → the name is the label");
ok(displayTitle({ name: "payments", title: "Payments Platform" }) === "Payments Platform", "a title wins for display");
ok(displayTitle({ name: "payments", title: "  " }) === "payments", "a whitespace-only title is treated as absent (never renders empty)");
ok(displayTitle({ name: "payments", title: "  Payments  " }) === "Payments", "a title is trimmed");
ok(displayTitle(undefined) === undefined, "an absent object has no label (callers fall back)");
ok(displayTitle({ name: "eng", title: "eng" }) === "eng", "a title equal to the name is harmless");

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-default", title: "Org baseline", domains: ["raw.githubusercontent.com"] })],
  loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "payments", title: "Payments Platform", channels: ["slack/T1/C1"] }),
    defineDomain({ name: "platform", channels: ["slack/T1/C2"] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

ok(
  (await friendlyScopeLabel("payments")) === "Payments Platform",
  "a domain-level scope key (a bare domain NAME) renders the domain's title on the card",
);
ok(
  (await friendlyScopeLabel("platform")) === undefined,
  "a domain with NO title stays raw — byte-identical to pre-OPE-218 behaviour, not a new label",
);
ok((await friendlyScopeLabel("no-such-domain")) === undefined, "an unknown bare key stays raw (fail-open, never throws)");
ok((await friendlyScopeLabel("slack/T1")) === undefined, "a qualified key is untouched by the domain arm");

ok(
  (await friendlyScopeLabel("Payments Platform")) === undefined,
  "the TITLE is not itself addressable — only the immutable name is a scope key",
);

console.log(`✓ display-title: ${n} assertions passed (name/title split + the domain scope-label render site)`);
