import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RESERVED_REACTION_SCENARIOS, reservedReactionScenarioIds } from "./e2e/reserved-scenarios.js";

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
  const entries = Object.entries(RESERVED_REACTION_SCENARIOS);
  ok(entries.length === 5, `all five wired reaction surfaces are reserved for (got ${entries.length})`);
  for (const [surface, reserved] of entries) {
    ok(/^J-REACT-[a-z]+$/u.test(reserved.id), `${surface}: the reserved id follows the journey-leg shape (${reserved.id})`);
    ok(reserved.id.endsWith(`-${surface}`), `${surface}: the id names its own surface — an id that names another is a leg pointed at the wrong workspace`);
    ok(reserved.proves.trim().length >= 40, `${surface}: the reservation states what the leg must prove`);
    ok(reserved.proves.includes("reaction"), `${surface}: …and it is about a reaction`);
  }
  ok(!Object.keys(RESERVED_REACTION_SCENARIOS).includes("notion"), "negative control: notion reserves nothing — it is not a reaction surface");
}

{
  const ids = reservedReactionScenarioIds();
  ok(new Set(ids).size === ids.length, `the reserved ids are unique (${ids.join(", ")})`);
}

{
  for (const id of reservedReactionScenarioIds()) {
    ok(!implementedIds.has(id), `🔴 ${id} is reserved, not implemented — a reservation the pack already answers to is not a reservation`);
  }
  ok(implementedIds.has("S-NOTION-WRITE"), "negative control: an id the pack does carry reads as implemented");
}

console.log(`✓ e2e reserved scenarios: ${n} assertions`);
