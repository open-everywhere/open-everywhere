import assert from "node:assert/strict";
import { registerBotDisplayName, botDisplayNameFor, _resetBotDisplayNamesForTest } from "../agent/identity/bot-display-name.js";

let n = 0;
const eq = async (actual: Promise<unknown>, expected: unknown, label: string): Promise<void> => {
  assert.deepStrictEqual(await actual, expected, label);
  n++;
};
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

_resetBotDisplayNamesForTest();

{
  registerBotDisplayName("slack", async () => "Ledge Pigeon");
  registerBotDisplayName("teams", async () => "open-everywhere");

  await eq(botDisplayNameFor("slack"), "Ledge Pigeon", "🔴 a registered arm's name is what the registry answers for its platform");
  await eq(botDisplayNameFor("teams"), "open-everywhere", "🔴 a SECOND platform answers with its OWN arm — the point of the registry (Teams borrowed the Slack name before OPE-569)");
  await eq(botDisplayNameFor("discord"), undefined, "🔴 NEGATIVE CONTROL: a platform with NO arm resolves undefined, so the assembler renders the generic identity line");
}

{
  registerBotDisplayName("slack", async () => "Renamed Bot");
  await eq(botDisplayNameFor("slack"), "Renamed Bot", "registering a platform again REPLACES its arm (the register* idempotence every provider seam has)");
}

{
  registerBotDisplayName("throws", async () => {
    throw new Error("graph 403");
  });
  registerBotDisplayName("blank", async () => "   ");
  registerBotDisplayName("empty", async () => "");
  registerBotDisplayName("nothing", async () => undefined);
  registerBotDisplayName("nonstring", (async () => 42) as unknown as () => Promise<string | undefined>);

  await eq(botDisplayNameFor("throws"), undefined, "🔴 an arm that THROWS reads undefined — a name lookup can never fail instruction assembly");
  await eq(botDisplayNameFor("blank"), undefined, "a whitespace-only name reads undefined, never a blank identity line");
  await eq(botDisplayNameFor("empty"), undefined, "an empty-string name reads undefined");
  await eq(botDisplayNameFor("nothing"), undefined, "an arm that resolves undefined stays undefined");
  await eq(botDisplayNameFor("nonstring"), undefined, "a non-string answer reads undefined — the registry never renders a coerced value");
  await eq(botDisplayNameFor(undefined), undefined, "an ABSENT platform reads undefined (an unbound session)");
  await eq(botDisplayNameFor(""), undefined, "a blank platform reads undefined");
}

{
  registerBotDisplayName("padded", async () => "  Aria  ");
  await eq(botDisplayNameFor("padded"), "Aria", "a padded name is trimmed before it reaches the identity line");
}

{
  ok((await botDisplayNameFor("slack")) !== undefined, "fixture guard: an arm IS registered before the reset — otherwise the assertion below proves nothing");
  _resetBotDisplayNamesForTest();
  await eq(botDisplayNameFor("slack"), undefined, "_resetBotDisplayNamesForTest drops every arm, so one test cannot inherit another's");
}

console.log(`bot-display-name-test: ${n} assertions passed`);
