import assert from "node:assert/strict";

const channel = (await import("../agent/channels/notion.js")).default as {
  __kind?: string;
  routes?: readonly unknown[];
  turnPolicy?: string;
};

assert.equal(
  channel.__kind,
  "eve:channel",
  "the default export of agent/channels/notion.ts is not a resolved eve Channel object — the " +
    "assertion below would not be reading the channel it is meant to hold",
);
assert.ok(
  Array.isArray(channel.routes) && channel.routes.length > 0,
  "the Notion Channel object carries no routes — this is not the dispatching channel, so a " +
    "turnPolicy pin on it would govern no session",
);

assert.equal(
  channel.turnPolicy,
  "queue",
  "the Notion channel must carry turnPolicy 'queue' on its resolved Channel object — either the " +
    "pin in agent/channels/notion.ts was removed, or eve's own defineChannel stopped copying " +
    "turnPolicy onto the Channel object (the upstream carriage, vercel/eve#2172 — tripwired by the " +
    "`carriage:` cases in packages/core/scripts/eve-install-integrity-test.ts; the OE patch hunks " +
    "were retired, do not port them back). Under eve's default 'steer' every Notion comment " +
    "cancels the turn in flight",
);

console.log("notion-turn-policy: 3 assertions passed — the Notion channel pins turnPolicy 'queue'");
