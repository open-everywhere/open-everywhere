import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LANDED_REACTION_SCENARIOS, RESERVED_REACTION_SCENARIOS, reservedReactionScenarioIds } from "./e2e/reserved-scenarios.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
const scenarioSource = readFileSync(join(here, "e2e", "scenarios.ts"), "utf8");
const implementedIds = new Set<string>([...scenarioSource.matchAll(/^\s*id:\s*"([^"]+)"/gmu)].map((m) => m[1]!));

{
  ok(implementedIds.size >= 20, `the scenario scan reads the live pack's ids (found ${implementedIds.size})`);
  ok(implementedIds.has("J-ENGAGED-github"), "…including a known one, so the pattern matches real entries");
}

{
  const entries = [...Object.entries(RESERVED_REACTION_SCENARIOS), ...Object.entries(LANDED_REACTION_SCENARIOS)];
  ok(entries.length === 5, `all five wired reaction surfaces are reserved for or landed (got ${entries.length})`);
  ok(new Set(entries.map(([surface]) => surface)).size === 5, "no surface is both reserved and landed");
  for (const [surface, reserved] of entries) {
    ok(/^J-REACT-[a-z]+$/u.test(reserved.id), `${surface}: the reserved id follows the journey-leg shape (${reserved.id})`);
    ok(reserved.id.endsWith(`-${surface}`), `${surface}: the id names its own surface — an id that names another is a leg pointed at the wrong workspace`);
    ok(reserved.proves.trim().length >= 40, `${surface}: the reservation states what the leg must prove`);
    ok(reserved.proves.includes("reaction"), `${surface}: …and it is about a reaction`);
  }
  ok(!entries.some(([surface]) => surface === "notion"), "negative control: notion reserves nothing — it is not a reaction surface");
}

{
  const ids = [...reservedReactionScenarioIds(), ...Object.values(LANDED_REACTION_SCENARIOS).map((s) => s.id)];
  ok(new Set(ids).size === ids.length, `the reserved and landed ids are unique (${ids.join(", ")})`);
}

{
  for (const id of reservedReactionScenarioIds()) {
    ok(!implementedIds.has(id), `🔴 ${id} is reserved, not implemented — a reservation the pack already answers to is not a reservation`);
  }
  ok(implementedIds.has("S-NOTION-WRITE"), "negative control: an id the pack does carry reads as implemented");
}

{
  for (const landed of Object.values(LANDED_REACTION_SCENARIOS)) {
    ok(implementedIds.has(landed.id), `🔴 ${landed.id} is landed, so the pack carries a scenario with that id`);
  }
}

console.log(`✓ e2e reserved scenarios: ${n} assertions`);
