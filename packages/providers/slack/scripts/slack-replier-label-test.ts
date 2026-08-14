import assert from "node:assert/strict";
import { slackReplierParams } from "../agent/channels/slack-post-arm.js";
import type { ReplierLabel } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("slackReplierParams:");

const worker: ReplierLabel = { taskLabel: "Fix the deploy pipeline" };

eq(
  slackReplierParams("Open Everywhere", worker),
  { username: "Open Everywhere [Fix the deploy pipeline]" },
  "a resolvable agent name + a worker-turn replier ⇒ the bracketed username override",
);

eq(slackReplierParams("Open Everywhere", undefined), {}, "NEGATIVE CONTROL: a supervisor/bare reply (no replier) gets no username override");
eq(slackReplierParams(undefined, worker), {}, "NEGATIVE CONTROL: an unresolvable agent name fails OPEN — no override rather than a name-less bracket");
eq(slackReplierParams("", worker), {}, "NEGATIVE CONTROL: an empty-string agent name is treated the same as unresolvable");
eq(slackReplierParams("   ", worker), {}, "NEGATIVE CONTROL: a whitespace-only agent name is treated the same as unresolvable");
eq(slackReplierParams(undefined, undefined), {}, "NEGATIVE CONTROL: neither present ⇒ no override");

console.log(`slack-replier-label-test: ${n} assertions passed`);
