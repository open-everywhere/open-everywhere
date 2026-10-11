import assert from "node:assert/strict";
import { BROWSER_TOOL_NAMES } from "../../agent/access/browser-toolkit.js";
import {
  pageTitle,
  THIRD_PARTY_JUDGE_CLAUSE,
  THIRD_PARTY_RECORDED_PAGE,
  THIRD_PARTY_REPLY_ASK,
  THIRD_PARTY_STEP,
  THIRD_PARTY_URL,
} from "./browser-third-party.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

ok(!/<h[1-6][\s>]/i.test(THIRD_PARTY_RECORDED_PAGE), "the recorded page serves NO heading element — the reason the old step judged red (OPE-2418)");
ok(pageTitle(THIRD_PARTY_RECORDED_PAGE) === "Example Domain", "the recorded page serves a <title> in its static markup");
ok(pageTitle("<html><head></head><body><h1>x</h1></body></html>") === null, "pageTitle: markup with no <title> has no title (negative control)");
ok(pageTitle("<title>  </title>") === null, "pageTitle: an empty <title> is no title");

const ask = `${THIRD_PARTY_STEP} ${THIRD_PARTY_REPLY_ASK} ${THIRD_PARTY_JUDGE_CLAUSE}`;
ok(!/heading/i.test(ask), "🔴 the third-party step, the reply ask and the judge clause never ask example.com for a heading");
ok(/page title/i.test(THIRD_PARTY_STEP), "🔴 the step asks for the PAGE TITLE");
ok(/page title/i.test(THIRD_PARTY_REPLY_ASK) && /page title/i.test(THIRD_PARTY_JUDGE_CLAUSE), "🔴 the reply ask and the judge clause name the same fact as the step");
ok(THIRD_PARTY_STEP.includes(THIRD_PARTY_URL) && THIRD_PARTY_URL === "https://example.com/", "the step opens the declared third-party page");

ok(/browser_get with \{ property: "title" \}/.test(THIRD_PARTY_STEP), "the step reads the title with browser_get { property: \"title\" } (a page property, no selector)");
ok((BROWSER_TOOL_NAMES as readonly string[]).includes("browser_get"), "browser_get is in the browser family's closed tool set");
ok(THIRD_PARTY_STEP.includes("browser_snapshot"), "the step still takes a snapshot — the leg's browser.snapshot gate needs the row");
ok(!THIRD_PARTY_STEP.includes("browser_evaluate"), "the step never asks for browser_evaluate — the kit mounts no page scripting");

console.log(`✓ e2e-browser-third-party: ${passed} assertions passed`);
