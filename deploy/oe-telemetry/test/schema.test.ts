import assert from "node:assert/strict";
import { EVENT_SCHEMA, RESOURCE_ATTR_KEYS } from "../src/schema.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const EXPECTED_EVENT_SCHEMA: Record<string, string[]> = {
  "oe.instance.first_boot": [],
  "oe.instance.heartbeat": [
    "oe.surfaces",
    "oe.memory_provider",
    "oe.operational_provider",
    "oe.model.primary",
    "oe.model.utility",
    "oe.domains.bucket",
    "oe.telemetry.dropped",
  ],
  "oe.turn.completed": ["oe.surface", "oe.kind", "gen_ai.request.model", "oe.tokens.bucket", "oe.steps.bucket", "oe.latency.bucket"],
  "oe.turn.failed": ["oe.surface", "oe.error.code"],
  "oe.error.uncaught": ["oe.component", "oe.error.name"],
  "oe.feature.used": ["oe.feature", "oe.outcome"],
  "oe.reaction.added": ["oe.surface", "oe.on_bot_reply", "oe.emoji_class"],
  "oe.reaction.removed": ["oe.surface", "oe.on_bot_reply", "oe.emoji_class"],
  "wizard.started": ["oe.wizard.version", "oe.wizard.platform"],
  "wizard.completed": ["oe.wizard.version", "oe.wizard.platform", "oe.wizard.steps_completed"],
};

const EXPECTED_RESOURCE_ATTR_KEYS = [
  "service.name",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
  "oe.host",
  "oe.node.major",
  "oe.instance.ephemeral",
];

{
  const actualEventNames = Object.keys(EVENT_SCHEMA).sort();
  const expectedEventNames = Object.keys(EXPECTED_EVENT_SCHEMA).sort();
  assert.deepEqual(actualEventNames, expectedEventNames, "the set of known event names matches the pinned contract exactly");
  n++;

  for (const eventName of expectedEventNames) {
    const actual = [...EVENT_SCHEMA[eventName]].sort();
    const expected = [...EXPECTED_EVENT_SCHEMA[eventName]].sort();
    assert.deepEqual(actual, expected, `${eventName}'s attribute allow-list matches the pinned contract exactly`);
    n++;
  }

  const actualResourceKeys = [...RESOURCE_ATTR_KEYS].sort();
  const expectedResourceKeys = [...EXPECTED_RESOURCE_ATTR_KEYS].sort();
  assert.deepEqual(actualResourceKeys, expectedResourceKeys, "resource attribute keys match the pinned contract exactly");
  n++;
}

{
  ok(Object.isFrozen(EVENT_SCHEMA), "EVENT_SCHEMA is frozen");
  for (const [name, attrs] of Object.entries(EVENT_SCHEMA)) {
    ok(Object.isFrozen(attrs), `EVENT_SCHEMA["${name}"]'s attribute list is frozen`);
  }
  ok(Object.isFrozen(RESOURCE_ATTR_KEYS), "RESOURCE_ATTR_KEYS is frozen");
}

console.log(`schema.test.ts: ${n} assertions passed`);
