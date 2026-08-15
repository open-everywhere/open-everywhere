import assert from "node:assert/strict";

const channel = (await import("../agent/channels/unified.js")).default as { turnPolicy?: string };
assert.equal(
  channel.turnPolicy,
  "queue",
  "the unified channel must carry turnPolicy 'queue' on its resolved Channel object — " +
    "either the pin in channels/unified.ts was removed, or the eve patch's defineChannel " +
    "restore hunk (OPE-448 / vercel-eve#2172) is missing from the installed bytes",
);

console.log("unified-turn-policy: 1 assertion passed — the window channel pins turnPolicy 'queue'");
