import { decideActingIdentity, namedOwnAccountVendor, type OwnAccountVendor } from "../agent/connections/own-account-ask.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GITHUB_CONNECTOR = "github";
const GH: readonly OwnAccountVendor[] = [{ aliases: ["github.com"], connector: GITHUB_CONNECTOR }];
const NOTION: OwnAccountVendor = { aliases: ["notion.so"], connector: "notion" };

ok(namedOwnAccountVendor(["read that PR with my own GitHub account"], GH)?.connector === GITHUB_CONNECTOR, "`my own GitHub account` is a GitHub own-account ask");
ok(namedOwnAccountVendor(["check my github login for me"], GH)?.connector === GITHUB_CONNECTOR, "`my github login` is a GitHub own-account ask");
ok(namedOwnAccountVendor(["look in github using my own credentials"], GH)?.connector === GITHUB_CONNECTOR, "an adjacent possessive binds to github");
ok(namedOwnAccountVendor(["read my own github.com account"], GH)?.connector === GITHUB_CONNECTOR, "the `github.com` alias is recognised");

ok(namedOwnAccountVendor(["read PR 12 in the widgets repo"], GH) === undefined, "an ordinary GitHub read is not an own-account ask");
ok(namedOwnAccountVendor(["ask my account manager about the github invoice"], GH) === undefined, "`my account manager` is not an own-account ask");
ok(namedOwnAccountVendor(["read that page with my own account at the bank"], GH) === undefined, "a possessive with no github nearby does not bind to github");
ok(namedOwnAccountVendor(["walk through my own account settings"], GH) === undefined, "`through` does not name github — this alias list carries no short word");
ok(namedOwnAccountVendor(["highlight my own credentials in the report"], GH) === undefined, "`highlight` does not name github");
ok(
  namedOwnAccountVendor(["walk through my own account settings"], [{ aliases: ["gh"], connector: GITHUB_CONNECTOR }])?.connector === GITHUB_CONNECTOR,
  "negative control: a SHORT alias does bind inside `through` — the hazard the long-word rule avoids is real",
);

const mixed = "read the Q3 page in Notion while I check my own GitHub account";
ok(namedOwnAccountVendor([mixed], [NOTION]) === undefined, "a GitHub possessive does not make a NOTION own-account ask");
ok(namedOwnAccountVendor([mixed], GH)?.connector === GITHUB_CONNECTOR, "the same sentence IS a GitHub own-account ask");

const ask = namedOwnAccountVendor(["read that PR with my own GitHub account"], GH);
ok(ask !== undefined, "the ask used by the decision arms is recognised");
const refused = decideActingIdentity({
  ask: ask!,
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: false,
  personalGrantHeld: false,
});
ok(refused.refusal !== undefined, "a GitHub own-account ask is REFUSED");
ok(refused.identity === undefined, "a refused verdict carries NO identity — a caller cannot read one off it");
ok(refused.requiredIdentity === "human-acting", "the refusal records that the request required the human-acting identity");
ok(refused.reason === "own-account-ask-no-grant", "the refusal names the closed reason");
ok(refused.refusal!.includes(GITHUB_CONNECTOR), "the refusal sentence names github");
ok(refused.refusal!.includes("no consent flow to start"), "the refusal says plainly that no consent route exists here");

const ordinary = decideActingIdentity({
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: false,
  personalGrantHeld: false,
});
ok(ordinary.refusal === undefined, "a turn with no own-account ask is NOT refused");
ok(ordinary.identity === "install", "a turn with no own-account ask runs under the install identity");
ok(ordinary.askRecognised === false, "a turn with no own-account ask records no ask");

const held = decideActingIdentity({
  ask: ask!,
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: true,
  personalGrantHeld: true,
});
ok(held.refusal !== undefined, "a held grant does not let a GitHub read run under the install token");
ok(held.identity === undefined, "the held-grant refusal carries no identity either");
ok(
  decideActingIdentity({ ask: ask!, callerCanSpendPersonal: true, connector: GITHUB_CONNECTOR, consentRouteAvailable: true, personalGrantHeld: true }).identity === "human-acting",
  "negative control: a caller that CAN spend personally is allowed the human-acting identity, so arm 6 is about the caller",
);

console.log(`✓ github acting identity: ${passed} assertions`);
