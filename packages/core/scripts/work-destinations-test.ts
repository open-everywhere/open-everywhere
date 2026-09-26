// proves: DELG-29

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { hasWorkGrant } from "../agent/access/work-grant.js";
import { workDestinationPlatforms } from "../agent/channels/work-destinations.js";
import { registerTicketCreateAdapter, resolveTicketCreate } from "../agent/channels/ticket-create.js";
import { registerEntityActionAdapter, resolveEntityAction } from "../agent/channels/entity-actions.js";
import { registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const CHAT = "testchat";
registerIdentityMapper(CHAT, (ctx) => {
  const a = (ctx as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_TEST" };
});

function chatCtx(room: string): BindableContext {
  return {
    channel: { kind: CHAT },
    session: { auth: { current: { attributes: { ws: "W1", room }, principalId: "U_TEST", principalType: "test-user" } } },
  } as unknown as BindableContext;
}

const PAY_ROOM = `${CHAT}/W1/CPAY`;
const ENG_ROOM = `${CHAT}/W1/CENG`;
const OPS_ROOM = `${CHAT}/W1/COPS`;

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", reach: [PAY_ROOM], credentials: [{ connector: "notion", credential: "team-key", use: "payments-work-key" }] }),
  defineDomain({ name: "eng", reach: [ENG_ROOM] }),
  defineDomain({
    name: "ops",
    reach: [OPS_ROOM],
    credentials: [
      { connector: "bugtracker", credential: "project-key", use: "ops-bugtracker" },
      { connector: "noworkspace", credential: "project-key", use: "ops-noworkspace" },
    ],
  }),
];

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    const key = `${workspaceKey}/${surface}`;
    return DOMAINS.filter((d) => (d.reach ?? []).includes(key)).map((d) => d.name);
  },
});

{
  ok(
    workDestinationPlatforms(chatCtx("CPAY"), DOMAINS).includes("notion") === false,
    "🔴 OPE-959: a domain HOLDING the notion work grant may NOT address notion while no notion adapter is registered (explicit false)",
  );
}

registerTicketCreateAdapter({
  platform: "notion",
  create: async (target) => ({ ref: { platform: "notion", id: `${target}#0` }, summary: "unused" }),
});

{
  const granted = workDestinationPlatforms(chatCtx("CPAY"), DOMAINS);
  ok(granted.includes("notion"), "🔴 OPE-931: a domain that holds the notion WORK credential may address notion, with NO notion chat channel anywhere in it");
  ok(
    granted.includes(CHAT) === false,
    "🔴 OPE-953: the window's OWN chat platform is NOT a work destination — talking somewhere never confers filing there (explicit false)",
  );
  ok(granted.join(",") === "notion", "…so the set is exactly the granted connectors, in their own sorted order");

  const ungranted = workDestinationPlatforms(chatCtx("CENG"), DOMAINS);
  ok(ungranted.includes("notion") === false, "NEGATIVE CONTROL: a domain that declares NO work role may not address notion (explicit false)");
  ok(ungranted.length === 0, "…and a domain with no work declaration at all addresses NOTHING — its chat channel buys it no destination");

  ok(workDestinationPlatforms(chatCtx("CENG"), DOMAINS).join(",") !== workDestinationPlatforms(chatCtx("CPAY"), DOMAINS).join(","), "a grant belongs to ONE domain — the other domain's set differs");

  ok(workDestinationPlatforms(chatCtx("CNOWHERE"), DOMAINS).includes("notion") === false, "a room in no memory domain holds no work grant (fail closed)");

  const blind = workDestinationPlatforms({} as unknown as BindableContext, DOMAINS);
  ok(blind.length === 0, "an identity-less ctx resolves NO grant and therefore NO destination (fails closed, does not throw)");
}

const created: { target: string; title: string; organizationId: string | undefined }[] = [];
registerTicketCreateAdapter({
  platform: "notion",
  create: async (target, draft, organizationId) => {
    created.push({ target, title: draft.title, organizationId });
    return { ref: { platform: "notion", id: `${target}#1` }, summary: `filed ${target}#1` };
  },
  workspaceFor: () => "granted-workspace",
});

{
  const resolved = await resolveTicketCreate(chatCtx("CPAY"), { platform: "notion", target: "DB-1" }, DOMAINS);
  ok(resolved.platform === "notion" && resolved.target === "DB-1", "🔴 THE FIX: a no-chat-channel domain with a notion WORK credential resolves a notion destination");
  ok(resolved.organizationId === "granted-workspace", "…and the adapter's granted workspace is frozen onto it as the credential selector");

  let msg = "";
  try {
    await resolveTicketCreate(chatCtx("CENG"), { platform: "notion", target: "DB-1" }, DOMAINS);
    assert.fail("expected a throw");
  } catch (err) {
    msg = String((err as Error).message);
  }
  ok(/not one of this session's work destinations/.test(msg), `NEGATIVE CONTROL: an ungranted domain is still refused (${msg})`);
  ok(msg.includes("credentials"), "…and the refusal names the config that WOULD grant it (a work credential), not a chat channel");
  ok(created.length === 0, "nothing was filed on either path — resolve never runs `create`");
}

const mutations: { id: string; value: string; organizationId: string | undefined }[] = [];
registerEntityActionAdapter({
  platform: "notion",
  setState: async (id, value, organizationId) => {
    mutations.push({ id, value, organizationId });
    return `set ${id} to ${value}`;
  },
  workspaceFor: () => "granted-workspace",
});

{
  const { ref, run } = await resolveEntityAction(chatCtx("CPAY"), "setState", { platform: "notion", id: "PAGE-1" }, DOMAINS);
  ok(ref.platform === "notion" && ref.id === "PAGE-1", "🔴 THE FIX: a granted domain may act on a notion entity from a chat room, with no notion chat channel");
  ok(ref.organizationId === "granted-workspace", "…and the adapter's granted workspace is frozen onto the REF, so the mutation runs under the granted credential");
  await run("Done");
  ok(mutations[0]?.organizationId === "granted-workspace", "…and it reaches the adapter fn as the third argument");

  await assert.rejects(
    () => resolveEntityAction(chatCtx("CENG"), "setState", { platform: "notion", id: "PAGE-1" }, DOMAINS),
    /not one of this session's work destinations/,
    "NEGATIVE CONTROL: an ungranted domain is still refused on the entity gate",
  );
  n++;
}

{
  const { ref } = await resolveEntityAction(chatCtx("CPAY"), "setState", { platform: "notion", id: "PAGE-1", organizationId: "own-workspace" }, DOMAINS);
  ok(ref.organizationId === "own-workspace", "a ref that already names its workspace keeps it — the turn's own stamp beats the grant");

  registerEntityActionAdapter({ platform: "noworkspace", workRole: "project-key", setState: async () => "ok" });
  const bare = await resolveEntityAction(chatCtx("COPS"), "setState", { platform: "noworkspace", id: "1" }, DOMAINS);
  ok(bare.ref.organizationId === undefined, "NEGATIVE CONTROL: an adapter with no workspaceFor leaves organizationId ABSENT — never a guessed credential selector");
}

type Handler = (event: unknown, ctx: unknown) => unknown;
async function armed(tool: unknown, c: BindableContext): Promise<unknown> {
  const handler = (tool as { events: Record<string, Handler> }).events["session.started"];
  return await handler({}, c);
}

{
  const createTicketDefault = (await import("../agent/tools/create_ticket.js")).default;
  const setStateDefault = (await import("../agent/tools/set_state.js")).default;
  const assignDefault = (await import("../agent/tools/assign.js")).default;
  const addLabelDefault = (await import("../agent/tools/add_label.js")).default;

  for (const [name, tool] of [
    ["create_ticket", createTicketDefault],
    ["set_state", setStateDefault],
    ["assign", assignDefault],
    ["add_label", addLabelDefault],
  ] as const) {
    ok((await armed(tool, chatCtx("CPAY"))) !== null, `🔴 THE FIX: ${name} MOUNTS for a granted domain whose only channel is a chat room`);
    ok((await armed(tool, chatCtx("CENG"))) === null, `NEGATIVE CONTROL: ${name} is ABSENT for the ungranted domain in the same deployment`);
  }
}

{
  ok(
    workDestinationPlatforms(chatCtx("COPS"), DOMAINS).includes("bugtracker") === false,
    "NEGATIVE CONTROL: a domain declaring the bugtracker work role addresses NOTHING while no bugtracker adapter is registered",
  );

  registerTicketCreateAdapter({
    platform: "bugtracker",
    workRole: "project-key",
    create: async (target) => ({ ref: { platform: "bugtracker", id: `${target}#1` }, summary: `filed ${target}#1` }),
  });

  ok(
    workDestinationPlatforms(chatCtx("COPS"), DOMAINS).includes("bugtracker"),
    "🔴 OPE-959: registering an adapter that NAMES its work role makes the platform addressable for a domain that declares that role — no core table names it",
  );
  ok(
    workDestinationPlatforms(chatCtx("CPAY"), DOMAINS).includes("bugtracker") === false,
    "NEGATIVE CONTROL: a domain that declares a DIFFERENT provider's work role is not admitted to bugtracker (the grant is still per-domain)",
  );
  ok(
    hasWorkGrant(DOMAINS[2], "bugtracker", "some-other-role") === false,
    "…and the ROLE decides — the same domain holds no grant under a role it never declared (explicit false)",
  );
}

{
  const { declareProviderSelection, clearProviderSelection } = await import("../agent/access/provider-selection.js");
  const { registeredWorkPlatforms } = await import("../agent/channels/work-registry.js");

  declareProviderSelection(["notion", "bugtracker"]);
  try {
    registerTicketCreateAdapter({
      platform: "ghost-tracker",
      workRole: "project-key",
      create: async (target) => ({ ref: { platform: "ghost-tracker", id: target }, summary: "never" }),
    });
    ok(
      registeredWorkPlatforms().includes("ghost-tracker") === false,
      "🔴 an UNSELECTED provider's adapter registration leaves NO row in the work registry (explicit false) — the gate upstream is why registerWorkPlatform needs none of its own",
    );
    ok(
      workDestinationPlatforms(chatCtx("COPS"), DOMAINS).includes("ghost-tracker") === false,
      "…so it can never be a work destination either, whatever a domain declares",
    );
    registerTicketCreateAdapter({
      platform: "bugtracker",
      workRole: "project-key",
      create: async (target) => ({ ref: { platform: "bugtracker", id: target }, summary: "ok" }),
    });
    ok(registeredWorkPlatforms().includes("bugtracker"), "NEGATIVE CONTROL: a SELECTED provider registering the same way DOES get its row");
  } finally {
    clearProviderSelection();
  }
}

console.log(`✓ ${n} work-destination assertions passed`);
