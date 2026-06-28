import "./_register-test-config.js";
import {
  buildSlackAuth,
  channelFactsFromRaw,
  channelFactsFromInfo,
  type ChannelFacts,
  type OpenEverywhereSlackAuth,
} from "../agent/channels/slack-identity.js";
import { bindFrom, slackMode, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { resolveAccessFor } from "../agent/access/request.js";
import { resolveAccess, type EffectiveAccess } from "../agent/access/resolver.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of [
  "OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL",
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL",
]) {
  delete process.env[k];
}

function ctxFromAuth(auth: OpenEverywhereSlackAuth): BindableContext {
  return { channel: { kind: "slack" }, session: { auth: { current: auth } } };
}

interface Resolved {
  binding: ReturnType<typeof bindFrom>;
  partition: ReturnType<typeof resolvePartition>;
  access: EffectiveAccess;
}

function dispatch(input: {
  userId: string;
  teamId: string;
  channelId: string;
  threadTs?: string;
  facts: ChannelFacts;
}): Resolved {
  const mode = slackMode(input.facts.channelType, input.channelId);
  const auth = buildSlackAuth({
    userId: input.userId,
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    channelType: input.facts.channelType,
    isPrivate: input.facts.isPrivate,
  });
  void mode;
  const ctx = ctxFromAuth(auth);
  return {
    binding: bindFrom(ctx),
    partition: resolvePartition(ctx),
    access: resolveAccessFor(ctx),
  };
}

const hostsOf = (a: EffectiveAccess) => a.reachableHosts.map((h) => h.host);
const orgLayer = (a: EffectiveAccess) => a.instructionStack.find((l) => l.source === "org");

{
  const raw: Record<string, unknown> = {
    type: "app_mention",
    user: "U_alice",
    text: "<@U_BOT> ship the release notes",
    channel: "C_ENG",
    channel_type: "channel",
    team: "T_ACME",
    ts: "1700159721.000100",
    thread_ts: "1700159720.000001",
  };
  const info = { ok: true, channel: { id: "C_ENG", is_channel: true, is_private: false } };
  const facts: ChannelFacts = { ...channelFactsFromRaw(raw), ...channelFactsFromInfo(info) };

  const { binding, partition, access } = dispatch({
    userId: raw.user as string,
    teamId: raw.team as string,
    channelId: raw.channel as string,
    threadTs: raw.thread_ts as string,
    facts,
  });

  ok(binding.platform === "slack", "A: platform = slack");
  ok(binding.workspace === "T_ACME" && binding.surface === "C_ENG", "A: workspace/surface from real ids");
  ok(binding.mode === "channel" && binding.visibility === "public", "A: public channel → channel/public");
  ok(binding.principalId === "U_alice", "A: principal from user id");
  ok(JSON.stringify(binding.target) === JSON.stringify({ channelId: "C_ENG" }), "A: post-back target = { channelId }");
  ok(partition.workspaceKey === "slack/T_ACME", "A: workspaceKey");
  ok(partition.surfaceKey === "slack/T_ACME/C_ENG", "A: surfaceKey");
  ok(orgLayer(access) !== undefined && /Never act outside/.test(orgLayer(access)!.text), "A: org baseline instruction present");
  ok(hostsOf(access).includes("raw.githubusercontent.com"), "A: org-default credential-less host reachable");
  ok(access.repos.length === 0 && access.connections.length === 0 && access.connectors.length === 0, "A: safe baseline — no repos/creds/connectors");
  ok(access.warnings.length === 0, "A: no broad-grant warnings");
}

{
  const raw: Record<string, unknown> = {
    type: "app_mention", user: "U_alice", channel: "C_SECRET",
    channel_type: "channel", team: "T_ACME", ts: "1700159722.000100",
  };
  const info = { ok: true, channel: { id: "C_SECRET", is_group: true, is_private: true } };
  const facts: ChannelFacts = { ...channelFactsFromRaw(raw), ...channelFactsFromInfo(info) };

  const { binding, access } = dispatch({
    userId: raw.user as string, teamId: raw.team as string, channelId: raw.channel as string, facts,
  });

  ok(binding.mode === "channel", "B: still a channel (not a DM)");
  ok(binding.visibility === "private", "B: is_private:true → visibility private (write-isolated)");
  ok(orgLayer(access) !== undefined, "B: private channel still reads shared (org) instruction");
}

{
  const raw: Record<string, unknown> = {
    type: "app_mention", user: "U_alice", channel: "C_UNKNOWN",
    team: "T_ACME", ts: "1700159723.000100",
  };
  const facts: ChannelFacts = channelFactsFromRaw(raw);

  const { binding } = dispatch({
    userId: raw.user as string, teamId: raw.team as string, channelId: raw.channel as string, facts,
  });

  ok(binding.mode === "channel", "C: channel mode");
  ok(binding.visibility === "private", "C: FAIL-CLOSED — unknown private bit resolves to private");
}

{
  const raw: Record<string, unknown> = {
    type: "message", user: "U_bob", channel: "D_bob",
    channel_type: "im", team: "T_ACME", ts: "1700159724.000100",
  };
  const facts: ChannelFacts = { channelType: "im", isPrivate: true };

  const { binding, partition, access } = dispatch({
    userId: raw.user as string, teamId: raw.team as string, channelId: raw.channel as string, facts,
  });

  ok(binding.mode === "dm", "D: message.im → dm mode");
  ok(binding.visibility === "private", "D: a DM is never public");
  ok(binding.principalId === "U_bob", "D: principal = the DM caller");
  ok(partition.surfaceKey === "slack/T_ACME/D_bob", "D: DM has its own surface partition");
  ok(orgLayer(access) === undefined, "D: DM isolation — org/workspace service bundles do NOT apply");
  ok(access.reachableHosts.length === 0, "D: DM with no personal bundle → fully denied");
}

console.log(`✓ slack e2e: ${passed} assertions passed (raw event → identity + memory + access; fail-closed + DM isolation)`);
