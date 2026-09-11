import assert from "node:assert/strict";
import {
  declareSurfaceCommandScope,
  reconcileSurfaceCommands,
  registerSurfaceCommandReconciler,
  resetSurfaceCommandRegistryForTest,
  surfaceCommandScopeFor,
  type SurfaceCommandOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  discordCommandDrift,
  projectCommand,
  reconcileDiscordCommands,
} from "@open-everywhere/provider-discord/agent/commands/discord-command-sync.js";
import { buildOeDiscordCommandDefinition } from "@open-everywhere/provider-discord/agent/commands/discord-commands.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const GUILD = "1300000000000000100";

function asVendorHeld(declared: Record<string, unknown>): Record<string, unknown> {
  const dressOption = (o: Record<string, unknown>): Record<string, unknown> => {
    const { required, options, ...rest } = o;
    return {
      ...rest,
      ...(required === true ? { required: true } : {}),
      description_localizations: null,
      name_localizations: null,
      ...(Array.isArray(options) ? { options: options.map((x) => dressOption(x as Record<string, unknown>)) } : {}),
    };
  };
  const { options, ...rest } = declared;
  return {
    ...rest,
    id: "1420000000000000001",
    application_id: "1410000000000000002",
    guild_id: GUILD,
    version: "1420000000000000003",
    default_member_permissions: null,
    nsfw: false,
    dm_permission: true,
    description_localizations: null,
    name_localizations: null,
    ...(Array.isArray(options) ? { options: options.map((x) => dressOption(x as Record<string, unknown>)) } : {}),
  };
}

function transport(answers: readonly { status: number; body?: unknown }[]) {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  let i = 0;
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ method: String(init.method ?? "GET"), url, body: typeof init.body === "string" ? init.body : undefined });
    const answer = answers[Math.min(i, answers.length - 1)];
    i++;
    return new Response(JSON.stringify(answer?.body ?? null), { status: answer?.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchLike };
}

const CREDS = { applicationId: "1410000000000000002", botToken: "not-a-real-token" } as const;

{
  const declared = buildOeDiscordCommandDefinition();
  const held = [asVendorHeld(declared)];

  const drift = discordCommandDrift(declared, held);
  eq(drift.changed, false, "🔴 §1 the command Discord already holds, in Discord's OWN wire shape, is NOT drift");
  ok(drift.reason.includes("already matches"), "…and the reason says so in one line");

  const projected = projectCommand(held[0]);
  eq(projected?.name, "oe", "§1 the projection keeps the name");
  eq(projected?.options.length, (declared["options"] as unknown[]).length, "§1 …and every declared option, none of the vendor's extras");
  const rate = projected?.options.find((o) => o.name === "rate");
  eq(rate?.options[0]?.required, true, "§1 a required option keeps `required: true`");
  const budget = projected?.options.find((o) => o.name === "budget");
  eq(budget?.required, false, "🔴 §1 an option Discord omitted `required` on projects to FALSE, not undefined — the default is part of the comparison");

  {
    const COMMAND_KEYS = new Set(["name", "type", "description", "options"]);
    const OPTION_KEYS = new Set(["name", "description", "type", "required", "min_value", "max_value", "options"]);
    const unseen: string[] = [];
    const walk = (node: Record<string, unknown>, allowed: Set<string>, path: string): void => {
      for (const key of Object.keys(node)) if (!allowed.has(key)) unseen.push(`${path}.${key}`);
      for (const child of Array.isArray(node["options"]) ? (node["options"] as Record<string, unknown>[]) : []) {
        walk(child, OPTION_KEYS, `${path}.${String(child["name"])}`);
      }
    };
    walk(declared, COMMAND_KEYS, "/oe");
    eq(unseen, [], "🔴 §1 every field the declaration sets is one the projection reads — extend projectCommand/projectOptions BEFORE declaring a new field, or drift on it is invisible");
  }

  const withStranger = [{ id: "9", name: "ask", type: 1, description: "an operator's own command" }, asVendorHeld(declared)];
  eq(discordCommandDrift(declared, withStranger).changed, false, "🔴 §1 another command at the same scope is neither compared nor touched");
}

{
  const declared = buildOeDiscordCommandDefinition();
  const held = asVendorHeld(declared);

  eq(discordCommandDrift(declared, []).changed, true, "§2 nothing registered at the scope is drift");
  ok(discordCommandDrift(declared, []).reason.includes("not registered"), "…and the reason names it");

  const wrongDescription = structuredClone(held);
  wrongDescription["description"] = "something an older deploy wrote";
  eq(discordCommandDrift(declared, [wrongDescription]).changed, true, "§2 a changed top-level description is drift");

  const noRate = structuredClone(held);
  noRate["options"] = (noRate["options"] as unknown[]).filter((o) => (o as { name: string }).name !== "rate");
  eq(discordCommandDrift(declared, [noRate]).changed, true, "🔴 §2 a MISSING subcommand is drift — this is the `/oe rate` case OPE-1687 exists for");

  const looseBound = structuredClone(held);
  const rateOpt = (looseBound["options"] as Record<string, unknown>[]).find((o) => o["name"] === "rate");
  ((rateOpt?.["options"] as Record<string, unknown>[])[0] as Record<string, unknown>)["max_value"] = 99;
  eq(discordCommandDrift(declared, [looseBound]).changed, true, "§2 a changed option bound is drift");

  const reordered = structuredClone(held);
  reordered["options"] = [...(reordered["options"] as unknown[])].reverse();
  eq(discordCommandDrift(declared, [reordered]).changed, true, "§2 a reordered option list is drift — Discord renders options in registration order");

  const notRequired = structuredClone(held);
  const rate2 = (notRequired["options"] as Record<string, unknown>[]).find((o) => o["name"] === "rate");
  delete ((rate2?.["options"] as Record<string, unknown>[])[0] as Record<string, unknown>)["required"];
  eq(discordCommandDrift(declared, [notRequired]).changed, true, "🔴 §2 a required option that Discord holds as OPTIONAL is drift — the projection's default cannot hide a real change");
}

{
  const declared = buildOeDiscordCommandDefinition();

  {
    const t = transport([{ status: 200, body: [asVendorHeld(declared)] }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { ...CREDS, fetch: t.fetchLike });
    eq(outcome.status, "unchanged", "🔴 §3a an in-step deployment reports `unchanged`");
    eq(t.calls.length, 1, "🔴 §3a …and issues EXACTLY ONE Discord call — the read. A second call here is a write on every cold start");
    eq(t.calls[0]?.method, "GET", "§3a …which is the GET");
  }

  {
    const t = transport([{ status: 200, body: [] }, { status: 201, body: { id: "1" } }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { ...CREDS, fetch: t.fetchLike });
    eq(outcome.status, "updated", "§3b a scope missing the command reports `updated`");
    eq(t.calls.length, 2, "§3b …with two calls: the read and the write");
    eq(t.calls[1]?.method, "POST", "🔴 §3b the write is a per-command POST (create-or-update by name), NOT the bulk PUT that would delete an operator's own commands at this scope");
    ok(t.calls[1]?.url.includes(`/guilds/${GUILD}/commands`), "§3b …addressed to the declared guild, so registration is instant and provable");
    const sent = JSON.parse(t.calls[1]?.body ?? "null") as Record<string, unknown>;
    eq(sent["name"], "oe", "§3b …carrying the declared command body");
    ok(Array.isArray(sent["options"]) && (sent["options"] as unknown[]).some((o) => (o as { name: string }).name === "rate"), "§3b …including `/oe rate`");
  }

  {
    const t = transport([{ status: 200, body: [] }, { status: 201, body: {} }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD, "2200000000000000009"] }, { ...CREDS, fetch: t.fetchLike, budgetMs: 0 });
    eq(outcome.status, "failed", "🔴 §3d a reconcile with no budget left reports `failed`, never a false `unchanged`");
    eq(t.calls.length, 0, "🔴 §3d …and issues NO vendor call at all — the budget bounds boot however many guilds are declared");
    ok(outcome.detail.includes("boot budget"), "…and says which bound it hit");
  }

  {
    const t = transport([{ status: 200, body: [] }, { status: 201, body: {} }, { status: 200, body: [] }, { status: 201, body: {} }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD, "2200000000000000009"] }, { ...CREDS, fetch: t.fetchLike });
    eq(outcome.status, "updated", "§3c two declared guilds both reconcile");
    eq(t.calls.length, 4, "…one read and one write each");
  }
}

{
  const declared = buildOeDiscordCommandDefinition();

  {
    const t = transport([{ status: 200, body: [] }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { applicationId: "", botToken: "", fetch: t.fetchLike });
    eq(outcome.status, "skipped", "🔴 §4 no credential ⇒ `skipped`, which is what a deployment carrying the bundle but no Discord app looks like");
    eq(t.calls.length, 0, "…and no vendor call is attempted at all — this is what keeps the offline test tiers network-free");
  }

  {
    const t = transport([{ status: 401, body: { message: "401: Unauthorized" } }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { ...CREDS, fetch: t.fetchLike });
    eq(outcome.status, "failed", "§4 a refused read reports `failed`");
    ok(outcome.detail.includes("401"), "…naming the status");
    ok(!outcome.detail.includes(CREDS.botToken) && !outcome.detail.includes("Unauthorized"), "🔴 §4 …and the detail carries NEITHER the bot token NOR the vendor's response body");
  }

  {
    const t = transport([{ status: 200, body: [] }, { status: 403 }]);
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { ...CREDS, fetch: t.fetchLike });
    eq(outcome.status, "failed", "§4 a refused write reports `failed`");
  }

  {
    const thrower = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD] }, { ...CREDS, fetch: thrower });
    eq(outcome.status, "failed", "🔴 §4 a thrown transport is caught — the reconciler never throws into boot");
    ok(!outcome.detail.includes("fetch failed"), "…and reports the error NAME, never a vendor message");
  }

  {
    const answers = [{ status: 200, body: [asVendorHeld(declared)] }, { status: 500 }];
    let i = 0;
    const mixed = async (): Promise<Response> => {
      const a = answers[Math.min(i, answers.length - 1)];
      i++;
      return new Response(JSON.stringify(a?.body ?? null), { status: a?.status ?? 200 });
    };
    const outcome = await reconcileDiscordCommands({ scopes: [GUILD, "2200000000000000009"] }, { ...CREDS, fetch: mixed });
    eq(outcome.status, "failed", "🔴 §4 one failing guild makes the whole outcome `failed`, even though another guild was in step");
  }
}

{
  resetSurfaceCommandRegistryForTest();

  assert.throws(
    () => declareSurfaceCommandScope("discord", { scopes: [] }),
    /register the commands nowhere/,
    "🔴 §5 a declaration naming no room is REFUSED at import — a config line that silently does nothing is how a command set stays unregistered",
  );
  n++;
  assert.throws(() => declareSurfaceCommandScope("discord", { scopes: [GUILD, GUILD] }), /listed twice/, "§5 a duplicated room is refused");
  n++;
  assert.throws(() => declareSurfaceCommandScope("discord", { scopes: [" "] }), /blank/, "§5 a blank room is refused");
  n++;
  assert.throws(() => declareSurfaceCommandScope("  ", { scopes: [GUILD] }), /non-empty name/, "§5 an unnamed platform is refused");
  n++;

  declareSurfaceCommandScope("discord", { scopes: [` ${GUILD} `] });
  eq(surfaceCommandScopeFor("discord")?.scopes, [GUILD], "§5 a declared room is trimmed and readable back");

  {
    const reports = await reconcileSurfaceCommands({ log: () => {} });
    eq(reports.length, 1, "§5 the boot call runs once per declared platform");
    eq(reports[0]?.outcome.status, "unsupported", "🔴 §5 a declared platform with no reconciler reports `unsupported` — never a silent skip");
  }

  {
    const seen: string[][] = [];
    registerSurfaceCommandReconciler("discord", async (scope): Promise<SurfaceCommandOutcome> => {
      seen.push([...scope.scopes]);
      return { status: "updated", detail: "registered" };
    });
    const reports = await reconcileSurfaceCommands({ log: () => {} });
    eq(seen, [[GUILD]], "🔴 §5 the plane hands the reconciler exactly the rooms the app declared");
    eq(reports[0]?.outcome.status, "updated", "§5 …and reports the reconciler's own outcome");
  }

  {
    registerSurfaceCommandReconciler("discord", async () => {
      throw new Error("vendor exploded");
    });
    const reports = await reconcileSurfaceCommands({ log: () => {} });
    eq(reports[0]?.outcome.status, "failed", "🔴 §5 a throwing reconciler is caught by the plane — `reconcileSurfaceCommands` never rejects");
  }

  resetSurfaceCommandRegistryForTest();
  eq(surfaceCommandScopeFor("discord"), undefined, "§5 the test reset drops every declaration, so one suite cannot inherit another's");
  eq((await reconcileSurfaceCommands({ log: () => {} })).length, 0, "§5 …and a deployment that declares nothing runs nothing");
}

console.log(`discord-command-registration-test: ${n} assertions passed`);
