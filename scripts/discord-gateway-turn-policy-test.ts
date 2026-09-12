import assert from "node:assert/strict";
import { assertPackageDistFresh } from "./core-dist-freshness.js";

assertPackageDistFresh("packages/providers/discord", "@open-everywhere/provider-discord");

const channel = (await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js"))
  .default as { __kind?: string; routes?: readonly unknown[]; turnPolicy?: string };

assert.equal(
  channel.__kind,
  "eve:channel",
  "the default export of provider-discord's discord-gateway.js is not a resolved eve Channel " +
    "object — the assertion below would not be reading the channel it is meant to hold",
);
assert.ok(
  Array.isArray(channel.routes) && channel.routes.length > 0,
  "the Discord gateway Channel object carries no routes — this is not the dispatching channel, " +
    "so a turnPolicy pin on it would govern no session",
);

assert.equal(
  channel.turnPolicy,
  "queue",
  "the Discord gateway channel must carry turnPolicy 'queue' on its resolved Channel object — " +
    "either the pin in packages/providers/discord/agent/channels/discord-gateway.ts was removed, " +
    "or eve's own defineChannel stopped copying turnPolicy onto the Channel object (the upstream " +
    "carriage, vercel/eve#2172 — tripwired by the `carriage:` cases in " +
    "packages/core/scripts/eve-install-integrity-test.ts; the OE patch hunks were retired, do not " +
    "port them back). Under eve's default 'steer' every Discord message cancels the turn in flight",
);

console.log(
  "discord-gateway-turn-policy: 3 assertions passed — the Discord message channel pins turnPolicy 'queue'",
);
