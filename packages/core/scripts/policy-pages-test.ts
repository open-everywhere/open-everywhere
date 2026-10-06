import {
  PRIVACY_PAGE_PATH,
  TERMS_PAGE_PATH,
} from "../agent/pages/policy-pages.js";
import { defineSettings, registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import channel from "../agent/channels/policy-pages.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

type Route = { readonly method: string; readonly path: string; readonly handler: (req: Request, args: unknown) => Promise<Response> };
const routes = (channel as unknown as { readonly routes: readonly Route[] }).routes;

async function fetchRoute(path: string): Promise<Response> {
  const route = routes.find((r) => r.path === path);
  if (route === undefined) throw new Error(`no route mounted at ${path}`);
  return route.handler(new Request(`https://deployment.example${path}`), {});
}

ok(routes.length === 2, `mount: exactly two routes (got ${routes.length})`);
ok(routes.some((r) => r.path === PRIVACY_PAGE_PATH), "mount: /privacy is mounted");
ok(routes.some((r) => r.path === TERMS_PAGE_PATH), "mount: /terms is mounted");
ok(PRIVACY_PAGE_PATH === "/privacy" && TERMS_PAGE_PATH === "/terms", "mount: the paths are the two the Teams manifest names");
ok(
  routes.every((r) => r.method === "GET"),
  "mount: both routes are GET — a policy page has nothing to submit",
);

resetSettingsForTest();
const unsetPrivacy = await fetchRoute(PRIVACY_PAGE_PATH);
const unsetTerms = await fetchRoute(TERMS_PAGE_PATH);
const unsetPrivacyBody = await unsetPrivacy.text();
const unsetTermsBody = await unsetTerms.text();

ok(unsetPrivacy.status === 200, `unset: /privacy answers 200, never 404 (got ${unsetPrivacy.status})`);
ok(unsetTerms.status === 200, `unset: /terms answers 200, never 404 (got ${unsetTerms.status})`);
ok(unsetPrivacyBody.includes("has not published a privacy policy yet"), "unset: /privacy says no policy is published");
ok(unsetTermsBody.includes("has not published a terms of use yet"), "unset: /terms says no terms are published");
ok(unsetPrivacyBody.includes("policyPages.privacy"), "unset: /privacy names the setting to declare the text in");
ok(unsetTermsBody.includes("policyPages.terms"), "unset: /terms names the setting to declare the text in");
ok(unsetPrivacyBody.includes("agent/settings/settings.ts"), "unset: /privacy names the file the setting lives in");
ok(!unsetPrivacyBody.includes("policyPages.terms"), "unset: /privacy names its OWN setting only");

const PRIVACY_TEXT = "We keep your messages for 30 days.\nWe sell nothing.";
const TERMS_TEXT = "Use it at your own risk. No warranty.";
registerSettings(defineSettings({ policyPages: { privacy: PRIVACY_TEXT, terms: TERMS_TEXT } }));

const setPrivacyBody = await (await fetchRoute(PRIVACY_PAGE_PATH)).text();
const setTermsBody = await (await fetchRoute(TERMS_PAGE_PATH)).text();

ok(setPrivacyBody.includes("We keep your messages for 30 days."), "set: /privacy serves the operator's privacy text");
ok(setTermsBody.includes("Use it at your own risk."), "set: /terms serves the operator's terms text");
ok(!setPrivacyBody.includes("Use it at your own risk."), "set: /privacy does NOT serve the terms (cross-wiring control)");
ok(!setTermsBody.includes("We keep your messages for 30 days."), "set: /terms does NOT serve the policy (cross-wiring control)");
ok(!setPrivacyBody.includes("has not published a privacy policy yet"), "set: the placeholder is gone once text is declared");
ok(setPrivacyBody.includes("30 days.\nWe sell nothing."), "set: the operator's newline survives into the body");
ok(setPrivacyBody.includes("pre-wrap"), "set: the page renders that newline (white-space: pre-wrap)");

registerSettings(defineSettings({ policyPages: { privacy: "<script>alert(1)</script> & <b>bold</b>" } }));
const escaped = await (await fetchRoute(PRIVACY_PAGE_PATH)).text();
ok(!escaped.includes("<script>"), "escape: an operator's raw <script> tag never reaches the page");
ok(!escaped.includes("<b>bold</b>"), "escape: operator markup is not rendered as markup");
ok(escaped.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "escape: it is shown as the text it is");
ok(escaped.includes("&amp;"), "escape: the ampersand is escaped too");

registerSettings({ policyPages: { privacy: "   \n  " } });
const blank = await (await fetchRoute(PRIVACY_PAGE_PATH)).text();
ok(blank.includes("has not published a privacy policy yet"), "blank: whitespace-only text renders the placeholder, not a blank page");

let refused = "";
try {
  defineSettings({ policyPages: { privacy: "   \n  " } });
} catch (err) {
  refused = err instanceof Error ? err.message : String(err);
}
ok(refused.includes("whitespace-only"), `validator: defineSettings refuses a whitespace-only document (message: "${refused}")`);

let accepted = true;
try {
  defineSettings({ policyPages: { privacy: "", terms: "Real terms." } });
} catch {
  accepted = false;
}
ok(accepted, "validator: empty (not published) and real text are both accepted");

resetSettingsForTest();
const headers = (await fetchRoute(PRIVACY_PAGE_PATH)).headers;
const publicBody = await (await fetchRoute(PRIVACY_PAGE_PATH)).text();
ok(headers.get("content-type") === "text/html; charset=utf-8", "headers: served as HTML");
ok((headers.get("cache-control") ?? "").includes("public"), "headers: cacheable — a public document, not one-shot capability material");
ok(!(headers.get("cache-control") ?? "").includes("no-store"), "headers: NOT no-store (the deliberate contrast with page-chrome.ts)");
ok(headers.get("referrer-policy") === null, "headers: no no-referrer — this page's URL carries no token");
ok(!publicBody.includes("noindex"), "headers: not noindex — an admin and an index are meant to find these");

resetSettingsForTest();
console.log(`✓ policy-pages: ${passed} assertions passed`);
