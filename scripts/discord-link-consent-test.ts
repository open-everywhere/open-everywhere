import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-link-consent-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
process.env.DISCORD_BOT_TOKEN = "fixture-bot-token-not-a-secret";

const ORG = "acme";
const TARGET = "U_TARGET_DISCORD";
const STRANGER = "U_SOMEBODY_ELSE";
const INITIATOR = "U_INITIATOR_SLACK";

const dmPosts: { channel: string; body: Record<string, unknown> }[] = [];
type StubRes = { ok: boolean; status: number; json: () => Promise<unknown> };
const res = (status: number, body: unknown): StubRes => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const fakeDiscordFetch = (async (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/api\/v\d+/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/users/@me/channels" && method === "POST") {
    const recipient = String(JSON.parse(init?.body ?? "{}").recipient_id ?? "");
    return res(200, { id: `DM_${recipient}` });
  }
  const create = /^\/channels\/([^/]+)\/messages$/.exec(path);
  if (create && method === "POST") {
    dmPosts.push({ channel: create[1]!, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return res(200, { id: `msg-${dmPosts.length}` });
  }
  return res(404, {});
}) as unknown as typeof fetch;

await withPatchedFetch(fakeDiscordFetch, async () => {

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { classifyDiscordInteraction } = await import("@open-everywhere/provider-discord/agent/channels/discord-front.js");
const { handleDiscordLinkConsentInteraction } = await import("@open-everywhere/provider-discord/agent/identity/discord-link-consent.js");
const { registerPostArm, dispatchDirectMessage } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { issueLinkChallenge } = await import("@open-everywhere/core/agent/identity/link-store.js");
const { linkConsentClickId, parseLinkConsentClickId, linkConsentActions, LINK_CONSENT_CLICK_ACTION } = await import(
  "@open-everywhere/core/agent/identity/link-consent.js"
);
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");

registerDiscordProvider();
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: ["discord/G1/C1"] })],
  loadSilos: () => [],
  domainsForSurface: () => ["payments"],
});

const initiatorNotices: { to: string; text: string }[] = [];
registerPostArm({
  platform: "slack",
  deliverDirectMessage: async (req) => {
    initiatorNotices.push({ to: req.principalId, text: req.text });
    return { surfaceId: "D_INIT", messageId: "m1" };
  },
});

const store = getOperationalStore();

async function askConsentOf(target: string): Promise<string> {
  const issued = await issueLinkChallenge({
    org: ORG,
    platform: "slack",
    tenant: "T1",
    nativeId: INITIATOR,
    surfaceKey: "slack/T1/D_INIT",
    transport: "directory",
    target: { platform: "discord", tenant: "", nativeId: target },
  });
  return issued.challenge.id;
}

function clickEnvelope(customId: string, userId: string, guildId?: string): unknown {
  return {
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    ...(guildId ? { guild_id: guildId, member: { user: { id: userId } } } : { user: { id: userId } }),
  };
}

async function statusOf(challengeId: string): Promise<string | undefined> {
  const rows = await store.listLinkChallenges(ORG, {});
  return rows.find((r) => r.id === challengeId)?.status;
}

const contentOf = (r: { body: Record<string, unknown> }): string => String(r.body["content"] ?? "");

{
  const round = parseLinkConsentClickId(linkConsentClickId("abc-123", "confirm"));
  ok(round?.challengeId === "abc-123" && round.verdict === "confirm", "§1 a click id round-trips its challenge id and verdict");

  const colon = parseLinkConsentClickId(linkConsentClickId("ab:cd", "deny"));
  ok(colon?.challengeId === "ab:cd" && colon.verdict === "deny", "🔴 §1 a challenge id containing a colon round-trips — the parse reads the verdict off the END");

  ok(parseLinkConsentClickId("oe-approval:abc:approve") === undefined, "§1 negative control: an APPROVAL id is not a consent id");
  ok(parseLinkConsentClickId("oe-link:abc:maybe") === undefined, "🔴 §1 negative control: an unknown verdict parses to NOTHING — the verdict is a closed set, never interpreted");
  ok(parseLinkConsentClickId("oe-link:") === undefined, "§1 negative control: an empty body parses to nothing");
  ok(parseLinkConsentClickId(undefined) === undefined, "§1 negative control: an absent custom_id parses to nothing");

  ok(linkConsentActions("x".repeat(200)).length === 0, "🔴 §1 an over-cap challenge id yields NO buttons — a text-only ask still delivers, which is why the copy never mentions a button");
  ok(linkConsentActions("abc-123").length === 2, "§1 an ordinary challenge id yields both buttons");
}

{
  dmPosts.length = 0;
  const actions = linkConsentActions("chal-1");
  await dispatchDirectMessage("discord", { principalId: TARGET, text: "somebody asked me to link your account", actions });

  ok(dmPosts.length === 1 && dmPosts[0]!.channel === `DM_${TARGET}`, "§2 the ask lands in the target's own DM");
  const components = dmPosts[0]!.body["components"] as { type: number; components: { custom_id: string; style: number; label: string }[] }[];
  ok(Array.isArray(components) && components.length === 1 && components[0]!.type === 1, "§2 the buttons ride ONE ACTION_ROW");
  const buttons = components[0]!.components;
  ok(buttons.length === 2 && buttons[0]!.custom_id === actions[0]!.id && buttons[1]!.custom_id === actions[1]!.id, "🔴 §2 both click ids reach the wire — a tap comes back carrying the challenge it answers");
  ok(buttons[0]!.style === 3 && buttons[1]!.style === 4, "§2 affirm renders green and reject renders red");
  ok(buttons.every((b) => !b.label.includes("chal-1")), "§2 a label carries no id and no interpolation — nothing attacker-chosen can reach one");

  dmPosts.length = 0;
  await dispatchDirectMessage("discord", { principalId: TARGET, text: "your link-set changed" });
  ok(dmPosts.length === 1 && dmPosts[0]!.body["components"] === undefined, "🔴 §2 negative control: a DM with NO actions posts no components at all");
}

{
  const ours = classifyDiscordInteraction(JSON.stringify(clickEnvelope("oe-link:abc:confirm", TARGET)));
  ok(ours.kind === "link-consent-click", "§3 an `oe-link:` component click is ours");
  const approval = classifyDiscordInteraction(JSON.stringify(clickEnvelope("oe-approval:abc:approve:acme", TARGET)));
  ok(approval.kind === "approval-click", "🔴 §3 negative control: the APPROVALS prefix still routes to the approvals plane — the new branch did not swallow it");
  const eve = classifyDiscordInteraction(JSON.stringify(clickEnvelope("eve_input:whatever", TARGET)));
  ok(eve.kind === "forward", "🔴 §3 negative control: eve's own HITL click still forwards untouched");
}

let confirmed: string;
{
  confirmed = await askConsentOf(TARGET);
  initiatorNotices.length = 0;

  const answer = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(confirmed, "confirm"), TARGET))) as {
    type: number;
    data: { content: string; flags: number };
  };

  ok(answer?.type === 4 && answer.data.flags === 64, "§4 the answer is EPHEMERAL — only the person who tapped sees it");
  ok(/NOTHING IS LINKED YET/.test(answer.data.content), "🔴 §4 the answer says nothing is linked yet — a consent is not a link, and the person must not think it is");
  ok((await statusOf(confirmed)) === "claimed", "🔴 §4 the consent is RECORDED on the real row — the tap ran the same CAS the typed door runs");
  ok(
    initiatorNotices.length === 1 && initiatorNotices[0]!.to === INITIATOR && /agreed to the link you asked for/.test(initiatorNotices[0]!.text),
    "🔴 §4 the INITIATOR is told — the button door runs the whole shared commit path, not just the CAS",
  );
  ok(!/code/i.test(initiatorNotices[0]!.text.split("\n")[0]!), "§4 the initiator notice never carries a code");

  const rows = await readAudit({ org: ORG, action: LINK_CONSENT_CLICK_ACTION });
  const row = rows.find((r) => (r.detail as { challengeId?: string })?.challengeId === confirmed);
  ok((row?.detail as { outcome?: string })?.outcome === "consented", "§4 one audit row names the outcome");
  ok(JSON.stringify(row?.detail ?? {}).includes(TARGET), "§4 the audit row names the account that tapped — ids only");
}

{
  const aimedAtTarget = await askConsentOf(TARGET);
  initiatorNotices.length = 0;

  const answer = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(aimedAtTarget, "confirm"), STRANGER))) as {
    data: { content: string };
  };

  ok((await statusOf(aimedAtTarget)) === "pending", "🔴 §5 a tap by ANOTHER account writes NOTHING — the row is still pending and still the target's to answer");
  ok(initiatorNotices.length === 0, "🔴 §5 and the initiator is told nothing — a stranger's tap cannot even produce a notice");
  ok(
    answer.data.content === (await import("@open-everywhere/core/agent/identity/link-flow.js")).linkConsentClickAnswers().notYours,
    "🔴 §5 the stranger gets the SAME answer as somebody whose request expired — the button is not an oracle for whether a challenge id names a real person",
  );

  const good = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(aimedAtTarget, "confirm"), TARGET))) as {
    data: { content: string };
  };
  ok(/NOTHING IS LINKED YET/.test(good.data.content) && (await statusOf(aimedAtTarget)) === "claimed", "🔴 §5 positive control: the NAMED account's tap on that same row is accepted");
}

{
  const inDm = await askConsentOf(TARGET);
  const answer = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(inDm, "confirm"), TARGET, "G_PUBLIC"))) as {
    data: { content: string };
  };
  ok(/direct messages/.test(answer.data.content), "§6 a tap carrying a guild id is refused with copy that says where to answer");
  ok((await statusOf(inDm)) === "pending", "🔴 §6 and nothing was written — the refusal happens BEFORE any lookup, so a room can never see a private identity outcome");
}

{
  const doomed = await askConsentOf(TARGET);
  const first = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(doomed, "deny"), TARGET))) as { data: { content: string } };
  ok(/Declined/.test(first.data.content), "§7 a deny tap says so plainly");
  ok((await statusOf(doomed)) === "denied", "🔴 §7 the row is DENIED — a deny writes the terminal state, it does not merely do nothing");

  const second = (await handleDiscordLinkConsentInteraction(clickEnvelope(linkConsentClickId(doomed, "confirm"), TARGET))) as { data: { content: string } };
  ok(/no open request|no longer open/.test(second.data.content), "🔴 §7 a SECOND tap on a decided request is answered honestly rather than re-deciding it");
  ok((await statusOf(doomed)) === "denied", "§7 and the row is untouched by the second tap");
}

ok((await statusOf(confirmed)) === "claimed", "§7 the §4 consent survived every later leg");

});

console.log(`✓ discord identity-consent button: ${passed} assertions passed`);

// proves: AP-MOD-core-identity-link-consent
