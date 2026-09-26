// proves: PAR-seat-context-admission
// proves: SEAT-12

import assert from "node:assert/strict";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitContextLines,
  admissionFunction,
  admissionFunctionNames,
  DEFAULT_ADMISSION,
  surfaceParityFor,
  grainUsesUnifiedWindow,
  type ContextLine,
  type SupervisorGrain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { admitDiscordSeatLines } from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";

assertCoreDistFresh();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const PLATFORMS = ["slack", "discord", "teams", "github", "linear", "notion"] as const;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADMISSION_IMPORT = /import\s*(?:type\s*)?\{[^}]*\badmitContextLines\b[^}]*\}\s*from\s*["'][^"']*adapter-api\.js["']/su;
const ADMISSION_CALL = /\badmitContextLines\s*\(/su;
const SLOT_FILL = /\bcontextLines\s*:/su;

function sourcesReference(dir: string, pattern: RegExp): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (sourcesReference(p, pattern)) return true;
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith("-test.ts")) continue;
    if (entry === "docs-generated.ts" || entry === "surface-parity.ts") continue;
    if (pattern.test(readFileSync(p, "utf8"))) return true;
  }
  return false;
}

interface SurfaceFacts {
  readonly platform: string;
  readonly fills: boolean;
  readonly onRoad: boolean;
}

const FACTS: readonly SurfaceFacts[] = PLATFORMS.map((platform) => {
  const dir = join(root, "packages", "providers", platform, "agent");
  return {
    platform,
    fills: sourcesReference(dir, SLOT_FILL),
    onRoad: sourcesReference(dir, ADMISSION_IMPORT) && sourcesReference(dir, ADMISSION_CALL),
  };
});

ok(FACTS.length === 6, "OPE-1838: all SIX surfaces are asked — a list short of one is a surface nobody checked");

for (const f of FACTS) {
  ok(
    !f.fills || f.onRoad,
    `🔴 ${f.platform}: POURS THROUGH THE ROAD — its hydration fills the seat's \`contextLines\` slot, so it must call \`admitContextLines\`. A pour beside the road hands the seat the very authors the domain's catch-up refused one step earlier (the OPE-1800 class)`,
  );
}

ok(
  FACTS.filter((f) => f.fills).length === 4,
  "🔴 OPE-1838 PRECONDITION: exactly FOUR surfaces pour into the slot today (Slack, Discord, GitHub, Linear) — without this the implication above would be vacuously true on a scan that matched nothing",
);
ok(
  FACTS.filter((f) => f.fills).map((f) => f.platform).join(",") === "slack,discord,github,linear",
  "OPE-1838 PRECONDITION: …and they are those four by name, so a surface that starts pouring is a change this file SEES rather than one it absorbs",
);
ok(
  FACTS.filter((f) => !f.fills).map((f) => f.platform).join(",") === "teams,notion",
  "OPE-1838: Teams and Notion pour NOTHING — their seats' room context is the catch-up read, which core already admits, so neither has an unpoliced slot to police",
);

{
  registerSlackProvider();
  registerDiscordProvider();
  registerTeamsProvider();
  registerGithubProvider();
  registerLinearProvider();
  registerNotionProvider();
  for (const f of FACTS) {
    const declared = surfaceParityFor(f.platform)?.["seat-context-admission"];
    const claims = declared === "supported" || (typeof declared === "object" && declared !== null && "supported" in declared);
    ok(declared !== undefined, `${f.platform}: the parity ledger answers the seat-context-admission row`);
    ok(
      claims === (f.fills && f.onRoad),
      `🔴 ${f.platform}: the ledger and the SOURCES agree — a surface never claims a policed pour it does not make, nor hides one it does`,
    );
  }
}

{
  const HYDRATION: readonly ContextLine[] = [
    { senderType: "user", senderId: "U-MEMBER", ts: "1", text: "a vouched member spoke", trust: "principal" },
    { senderType: "user", senderId: "U-GUEST", ts: "2", text: "a Slack Connect stranger spoke", trust: "unauth" },
    { senderType: "bot", senderId: "B-1", ts: "3", text: "a foreign bot posted", trust: "relay" },
    { senderType: "agent", ts: "4", text: "this bot's own prior post" },
  ];

  const textsFor = (name: string) => admitContextLines(HYDRATION, admissionFunction(name), "channel").map((l) => l.text);

  const wide = textsFor("wide");
  ok(wide.length === 3, "wide: the member, the stranger and the bot's own prior post enter");
  ok(!wide.some((t) => t.includes("foreign bot")), "🔴 wide: a foreign bot does NOT enter — a domain that wants machine chatter says so by name");

  const withBots = textsFor("wide-with-bots");
  ok(withBots.length === 4, "wide-with-bots: the attributable foreign bot enters beside everything `wide` admits");
  ok(withBots.some((t) => t.includes("foreign bot")), "🔴 wide-with-bots: …and it is the BOT line that the extra cell is — NEGATIVE CONTROL for the `wide` assertion above, which would otherwise pass on any policy that dropped any one line");

  const members = textsFor("members-only");
  ok(members.length === 2, "members-only: the vouched member and the bot's own prior post enter");
  ok(members.some((t) => t.includes("vouched member")), "members-only: a POSITIVELY vouched person is admitted");
  ok(!members.some((t) => t.includes("stranger")), "🔴 members-only: an unresolvable person is REFUSED — the whole point of the policy, and the line the OPE-1800 class handed the seat anyway");
  ok(!members.some((t) => t.includes("foreign bot")), "members-only: and so is every foreign bot");

  ok(
    admitContextLines(HYDRATION, admissionFunction("wide-with-bots"), "channel").map((l) => l.ts).join(",") === "1,2,3,4",
    "the road keeps the room's own order — a reordering filter would change which lines the cap upstream keeps",
  );

  ok(admissionFunctionNames().join(",") === "wide,wide-with-bots,members-only", "the three registered policy names, in declaration order");
  ok(
    admitContextLines(HYDRATION, admissionFunction(undefined), "channel").length === wide.length,
    `an unnamed policy resolves to the ${DEFAULT_ADMISSION} default — the wide answer, which is what a domain that declared nothing gets`,
  );
  ok(
    admitContextLines(HYDRATION, admissionFunction("no-such-policy"), "channel").length === wide.length,
    "…and so does a name no registry entry answers: config load already refused every unknown name, so widening here matches the pre-feature behaviour rather than blinding a live seat",
  );
}

{
  const LINES: readonly ContextLine[] = [
    { senderType: "user", senderId: "U-GUEST", ts: "1", text: "a guest spoke", trust: "unauth" },
    { senderType: "user", senderId: "U-MEMBER", ts: "2", text: "a member spoke", trust: "principal" },
  ];
  const SEATED: SupervisorGrain = { unified: true, registryKey: "discord/G1/CH", domainName: "d", singleWindow: true };
  const UNSEATED: SupervisorGrain = { unified: false, registryKey: "discord/G1/CH" };
  ok(grainUsesUnifiedWindow(SEATED) && !grainUsesUnifiedWindow(UNSEATED), "discord PRECONDITION: the two grains really are a seat and a seatless room by the product's own predicate");
  const WITH_BOT: readonly ContextLine[] = [...LINES, { senderType: "bot", senderId: "B-1", ts: "3", text: "a foreign bot posted", trust: "relay" }];
  const seated = admitDiscordSeatLines(WITH_BOT, SEATED, "discord/G1/CH", false);
  const unseated = admitDiscordSeatLines(WITH_BOT, UNSEATED, "discord/G1/CH", false);
  ok(unseated?.length === 3, "discord: an UNSEATED room keeps its whole hydration, foreign bot included — there is no seat for a seat policy to govern, and the shipped `wide` default would strip that line");
  ok(unseated === WITH_BOT, "🔴 discord: …and it is the SAME array, not a copy — this road was byte-identical before OPE-1800 and must stay so");
  ok(
    seated?.length === 2 && !seated.some((l) => l.text.includes("foreign bot")),
    "🔴 discord: a SEATED room's hydration is JUDGED — the foreign bot the domain's `wide` policy refuses does not reach the seat. Replace the wrapper's policed leg with a bare `return lines` and this goes red, which the count alone never did",
  );
  ok(seated !== WITH_BOT, "discord: …and the seated leg hands back the road's own array, never the caller's input");
  ok(
    admitDiscordSeatLines([], SEATED, "discord/G1/CH", false) === undefined && admitDiscordSeatLines(undefined, SEATED, "discord/G1/CH", false) === undefined,
    "discord: nothing to admit yields `undefined`, the shape an absent fetch produces — never an empty slot, which renders as a quiet room",
  );
}

{
  const ungradedPerson: ContextLine = { senderType: "user", senderId: "U-?", ts: "1", text: "nobody graded me" };
  const ungradedBot: ContextLine = { senderType: "bot", senderId: "B-?", ts: "2", text: "an ungraded bot" };
  const members = admissionFunction("members-only");
  const withBots = admissionFunction("wide-with-bots");

  ok(
    admitContextLines([ungradedPerson], members, "channel").length === 0,
    "🔴 an UNGRADED person floors at `unauth`, so `members-only` refuses a line it never checked rather than admitting one on trust it never resolved",
  );
  ok(
    admitContextLines([{ ...ungradedPerson, trust: "principal" }], members, "channel").length === 1,
    "NEGATIVE CONTROL: the SAME line carrying a resolved `principal` IS admitted — so the refusal above is the missing grade, not the sender kind",
  );
  ok(
    admitContextLines([ungradedBot], withBots, "channel").length === 1,
    "🔴 an ungraded MACHINE author floors at its own `relay` tier, so a `wide-with-bots` domain still gets the attributable bots it asked for — a surface's regrade grades people and never machine authors",
  );
  ok(
    admitContextLines([ungradedBot], admissionFunction("wide"), "channel").length === 0,
    "NEGATIVE CONTROL: the same ungraded bot under `wide` is refused — so the admission above is the policy's doing, not a floor that admits everything",
  );

  const unknown: ContextLine = { senderType: "unknown", ts: "3", text: "the surface could not attribute this" };
  ok(
    admitContextLines([unknown], members, "channel").length === 0,
    "🔴 a line the surface could NOT ATTRIBUTE is a person it could not vouch — `members-only` refuses it. Mapping it to `system` would admit it under every policy",
  );
  ok(
    admitContextLines([unknown], admissionFunction("wide"), "channel").length === 1,
    "NEGATIVE CONTROL: `wide` admits that same unattributable line — so the refusal above is `members-only` deciding, not the mapping dropping the line outright",
  );

  ok(
    admitContextLines([ungradedPerson], (c) => c.type === "thread", "thread").length === 1 &&
      admitContextLines([ungradedPerson], (c) => c.type === "thread", "channel").length === 0,
    "the caller's leg reaches the policy as `type` — the hydration's thread leg reads `thread`, its channel leg `channel`",
  );

  let sawText = false;
  admitContextLines([ungradedPerson], (c) => {
    sawText = "text" in (c as unknown as Record<string, unknown>);
    return true;
  }, "channel");
  ok(!sawText, "🔴 NEGATIVE CONTROL: the message BODY never reaches a policy — an admission function that judged the text would stop being goldenable from its name");
}

console.log(`✓ seat-admission-parity: ${n} assertions — 6 surfaces, one road, fill ⇒ call`);
