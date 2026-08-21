import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
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

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", channels: [PAY_ROOM], credentials: [{ connector: "notion", credential: "team-key", use: "payments-work-key" }] }),
  defineDomain({ name: "eng", channels: [ENG_ROOM] }),
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
    return DOMAINS.filter((d) => (d.channels ?? []).includes(key)).map((d) => d.name);
  },
});

{
  const granted = workDestinationPlatforms(chatCtx("CPAY"), DOMAINS);
  ok(granted.includes("notion"), "🔴 THE FIX: a domain that holds the notion WORK credential may address notion, with NO notion chat channel anywhere in it");
  ok(granted.includes(CHAT), "…and the window's own source is still in the set (the union never narrows)");
  ok(granted[0] === CHAT, "sources come first, so platform inference reads exactly as it did before");

  const ungranted = workDestinationPlatforms(chatCtx("CENG"), DOMAINS);
  ok(ungranted.includes("notion") === false, "NEGATIVE CONTROL: a domain that declares NO work role may not address notion (explicit false)");
  ok(ungranted.includes(CHAT), "…while its own source is unaffected");

  ok(workDestinationPlatforms(chatCtx("CENG"), DOMAINS).join(",") !== workDestinationPlatforms(chatCtx("CPAY"), DOMAINS).join(","), "a grant belongs to ONE domain — the other domain's set differs");

  ok(workDestinationPlatforms(chatCtx("CNOWHERE"), DOMAINS).includes("notion") === false, "a room in no memory domain holds no work grant (fail closed)");

  const blind = workDestinationPlatforms({} as unknown as BindableContext, DOMAINS);
  ok(blind.includes("notion") === false, "an identity-less ctx resolves NO grant (the resolution fails closed, it does not throw)");
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

  registerEntityActionAdapter({ platform: "test-no-workspace", setState: async () => "ok" });
  const ownSurface = { channel: { kind: "test-no-workspace" }, session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  const bare = await resolveEntityAction(ownSurface, "setState", { platform: "test-no-workspace", id: "1" }, DOMAINS);
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

console.log(`✓ ${n} work-destination assertions passed`);
