import {
  FIXTURE_FAMILIES,
  classifyAll,
  fixtureDoctorResult,
  renderFixtureReport,
  type ClassifiedFixture,
  type FixtureFinding,
  type ProbeOutcome,
} from "./fixture-doctor-lib.js";
import { ENV, teamsRefreshSinkPath } from "./env.js";
import { roomIdFor } from "./fixture-inventory-lib.js";
import { TeamsDriver } from "./teams-driver.js";
import { NotionDriver } from "./notion-driver.js";

type Env = Record<string, string | undefined>;

const args = process.argv.slice(2);
const json = args.includes("--json");
const timeoutIdx = args.findIndex((a) => a === "--timeout-ms");
const timeoutMs = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) || 15_000 : 15_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function outcome(ok: boolean, detail: string): ProbeOutcome {
  return { ok, detail };
}

async function safe(what: string, fn: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  try {
    return await withTimeout(fn(), what);
  } catch (err) {
    return outcome(false, `${what} failed: ${String(err instanceof Error ? err.message : err)}`);
  }
}

interface SlackApiResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly [k: string]: unknown;
}

async function slackApi(token: string, method: string, params: Record<string, string> = {}): Promise<SlackApiResult> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}${qs ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as SlackApiResult;
}

async function probeSlackBase(env: Env): Promise<ProbeOutcome> {
  return safe("slack auth.test + conversations.info", async () => {
    const token = env[ENV.slackUserToken]!;
    const channel = roomIdFor(ENV.slackChannel, env)!;
    const auth = await slackApi(token, "auth.test");
    if (!auth.ok) return outcome(false, `auth.test failed: ${auth.error ?? "unknown"}`);
    const chan = await slackApi(token, "conversations.info", { channel });
    if (!chan.ok) return outcome(false, `conversations.info(${channel}) failed: ${chan.error ?? "unknown"}`);
    const info = chan.channel as { is_archived?: boolean; name?: string } | undefined;
    if (info?.is_archived) return outcome(false, `conversations.info(${channel}) — channel "${info.name ?? channel}" is archived`);
    return outcome(true, `auth.test ok (team ${String(auth.team ?? "?")}); conversations.info(${channel}) ok, not archived`);
  });
}

async function probeSlackSecondary(env: Env): Promise<ProbeOutcome> {
  return safe("slack secondary auth.test", async () => {
    const token = env[ENV.slackSecondaryToken]!;
    const expectedUserId = env[ENV.slackSecondaryUserId]!;
    const auth = await slackApi(token, "auth.test");
    if (!auth.ok) return outcome(false, `auth.test failed: ${auth.error ?? "unknown"}`);
    if (auth.user_id !== expectedUserId) {
      return outcome(false, `auth.test resolved a DIFFERENT user than ${ENV.slackSecondaryUserId} declares — the token/id pair no longer matches`);
    }
    return outcome(true, `auth.test ok — resolves to the declared ${ENV.slackSecondaryUserId}`);
  });
}

async function probeSlackUser(env: Env): Promise<ProbeOutcome> {
  const token = env[ENV.slackUserToken];
  if (!token) return outcome(false, `no ${ENV.slackUserToken} available to call users.info`);
  return safe("slack users.info", async () => {
    const userId = env[ENV.slackUser2Id]!;
    const res = await slackApi(token, "users.info", { user: userId });
    if (!res.ok) return outcome(false, `users.info(${userId}) failed: ${res.error ?? "unknown"}`);
    return outcome(true, `users.info(${userId}) ok — a real workspace member`);
  });
}

async function probeSlackChannel(env: Env, channelVar: string): Promise<ProbeOutcome> {
  const token = env[ENV.slackUserToken];
  if (!token) return outcome(false, `no ${ENV.slackUserToken} available to call conversations.info`);
  return safe("slack conversations.info", async () => {
    const channel = roomIdFor(channelVar, env)!;
    const res = await slackApi(token, "conversations.info", { channel });
    if (!res.ok) return outcome(false, `conversations.info(${channel}) failed: ${res.error ?? "unknown"}`);
    const info = res.channel as { is_archived?: boolean; name?: string } | undefined;
    if (info?.is_archived) return outcome(false, `conversations.info(${channel}) — channel "${info.name ?? channel}" is archived`);
    return outcome(true, `conversations.info(${channelVar}=${channel}) ok, not archived`);
  });
}

async function probeSlackDmChannel(env: Env, channelVar: string): Promise<ProbeOutcome> {
  const token = env[ENV.slackUserToken];
  if (!token) return outcome(false, `no ${ENV.slackUserToken} available to call conversations.history`);
  return safe("slack conversations.history", async () => {
    const channel = roomIdFor(channelVar, env)!;
    const res = await slackApi(token, "conversations.history", { channel, limit: "1" });
    if (!res.ok) return outcome(false, `conversations.history(${channel}) failed: ${res.error ?? "unknown"}`);
    return outcome(true, `conversations.history(${channelVar}=${channel}) ok (im:history scope)`);
  });
}

async function probeSlackChannelPair(env: Env, channelVars: readonly [string, string]): Promise<ProbeOutcome> {
  const token = env[ENV.slackUserToken];
  if (!token) return outcome(false, `no ${ENV.slackUserToken} available to call conversations.info`);
  return safe("slack conversations.info (pair)", async () => {
    const results = await Promise.all(
      channelVars.map(async (name) => {
        const channel = roomIdFor(name, env)!;
        const res = await slackApi(token, "conversations.info", { channel });
        const info = res.channel as { is_archived?: boolean } | undefined;
        return { name, channel, ok: res.ok && !info?.is_archived, error: res.error };
      }),
    );
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) return outcome(false, `conversations.info failed for: ${bad.map((b) => `${b.name}=${b.channel} (${b.error ?? "archived"})`).join("; ")}`);
    return outcome(true, `conversations.info ok on both: ${results.map((r) => `${r.name}=${r.channel}`).join(", ")}`);
  });
}

async function discordApi(token: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { authorization: `Bot ${token}` } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function probeDiscordBase(env: Env): Promise<ProbeOutcome> {
  return safe("discord users/@me + channel fetch", async () => {
    const token = env[ENV.discordDriverToken]!;
    const channel = env[ENV.discordChannel]!;
    const me = await discordApi(token, "/users/@me");
    if (me.status !== 200) return outcome(false, `GET /users/@me → ${me.status} — driver bot token is invalid or revoked`);
    const chan = await discordApi(token, `/channels/${channel}`);
    if (chan.status !== 200) return outcome(false, `GET /channels/${channel} → ${chan.status} — channel missing or bot lacks access`);
    return outcome(true, `bot token valid (id ${String(me.json.id ?? "?")}); channel ${channel} reachable`);
  });
}

async function probeTeams(env: Env): Promise<ProbeOutcome> {
  return safe("teams token mint + channel fetch", async () => {
    const driver = new TeamsDriver({
      tenantId: env[ENV.teamsTenantId]!,
      clientId: env[ENV.teamsClientId]!,
      refreshToken: env[ENV.teamsRefreshToken]!,
      teamId: env[ENV.teamsTeamId]!,
      channelId: env[ENV.teamsChannelId]!,
      refreshTokenFile: teamsRefreshSinkPath(env),
      botAppId: env[ENV.teamsBotAppId]!,
    });
    const info = await driver.channelInfo();
    return outcome(true, `Graph token minted; channel "${info.displayName || info.id}" reachable`);
  });
}

async function githubApi(token: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function probeGithub(env: Env): Promise<ProbeOutcome> {
  return safe("github viewer + repo + issue", async () => {
    const token = env[ENV.githubDriverToken]!;
    const repo = env[ENV.githubRepo]!;
    const issue = env[ENV.githubIssue]!;
    const viewer = await githubApi(token, "/user");
    if (viewer.status !== 200) return outcome(false, `GET /user → ${viewer.status} — driver PAT is invalid or revoked`);
    const repoRes = await githubApi(token, `/repos/${repo}`);
    if (repoRes.status !== 200) return outcome(false, `GET /repos/${repo} → ${repoRes.status} — fixture repo missing or PAT lacks access`);
    const issueRes = await githubApi(token, `/repos/${repo}/issues/${issue}`);
    if (issueRes.status !== 200) return outcome(false, `GET /repos/${repo}/issues/${issue} → ${issueRes.status} — fixture issue missing`);
    if (issueRes.json.state !== "open") return outcome(false, `issue #${issue} on ${repo} is "${String(issueRes.json.state)}", not open — the fixture must stay open`);
    return outcome(true, `viewer ${String(viewer.json.login ?? "?")} ok; ${repo} reachable; issue #${issue} open`);
  });
}

async function probeGithubPr(env: Env): Promise<ProbeOutcome> {
  return safe("github PR-target repo reachability", async () => {
    const token = env[ENV.githubDriverToken]!;
    const repo = env[ENV.prRepo]!;
    const repoRes = await githubApi(token, `/repos/${repo}`);
    if (repoRes.status !== 200) return outcome(false, `GET /repos/${repo} → ${repoRes.status} — PR-target repo missing or PAT lacks access`);
    return outcome(true, `${repo} reachable with the driver PAT`);
  });
}

async function probeGithubRepo(env: Env, repoVar: string): Promise<ProbeOutcome> {
  return safe("github repo reachability", async () => {
    const token = env[ENV.githubDriverToken]!;
    const repo = roomIdFor(repoVar, env);
    if (!repo) return outcome(false, `no repo for ${repoVar} — neither the variable nor TRACKED_ROOM_IDS carries one`);
    const res = await githubApi(token, `/repos/${repo}`);
    if (res.status === 404) {
      return outcome(
        false,
        `GET /repos/${repo} → 404 — the repo is missing, OR the fine-grained ${ENV.githubDriverToken} does not list it among its selected repositories`,
      );
    }
    if (res.status !== 200) return outcome(false, `GET /repos/${repo} → ${res.status}`);
    const isPrivate = res.json["private"] === true;
    if (!isPrivate) return outcome(false, `${repo} is PUBLIC — J-ENGAGED-github's non-mention arm refuses a public repo, so step (b) can never pass`);
    return outcome(true, `${repo} reachable with the driver PAT, and private`);
  });
}

async function probeLinear(env: Env): Promise<ProbeOutcome> {
  return safe("linear viewer + team", async () => {
    const apiKey = env[ENV.linearApiKey]!;
    const teamId = env[ENV.linearTeamId]!;
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($teamId:String!){ viewer { id displayName } team(id:$teamId) { id name } }`,
        variables: { teamId },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { viewer?: { id?: string }; team?: { id?: string; name?: string } }; errors?: { message?: string }[] };
    if (!res.ok || json.errors) return outcome(false, `linear graphql failed: ${json.errors?.map((e) => e.message).join("; ") ?? `http ${res.status}`}`);
    if (!json.data?.viewer?.id) return outcome(false, "linear graphql — PAT did not resolve a viewer (revoked?)");
    if (!json.data?.team?.id) return outcome(false, `linear graphql — team ${teamId} did not resolve (deleted or PAT lacks access)`);
    return outcome(true, `viewer resolves; team "${json.data.team.name ?? teamId}" resolves`);
  });
}

async function probeNotionAmbient(env: Env): Promise<ProbeOutcome> {
  return safe("notion page + block-level anchor sweep", async () => {
    const driver = new NotionDriver({
      driverKey: env[ENV.notionDriverKey]!,
      pageId: env[ENV.notionAmbientPageId]!,
      botUserId: env[ENV.notionBotUserId]!,
      workspaceId: env[ENV.notionWorkspaceId]!,
    });
    await driver.pageBlocks();
    const anchorVars: readonly string[] = [ENV.notionAnchorOnTopic, ENV.notionAnchorOnTopic2, ENV.notionAnchorOffTopic, ENV.notionAnchorHuman];
    const setAnchors: { varName: string; id: string }[] = [];
    for (const varName of anchorVars) {
      const id = env[varName];
      if (id) setAnchors.push({ varName, id });
    }
    if (setAnchors.length === 0) return outcome(true, "page reachable; no manual anchor comment ids set (forge legs will self-skip)");
    const results = await Promise.all(setAnchors.map(async ({ varName, id }) => ({ varName, id, discussionId: await driver.discussionOf(id) })));
    const missing = results.filter((r) => !r.discussionId);
    if (missing.length > 0) {
      return outcome(false, `anchor comment(s) no longer found (page+block sweep): ${missing.map((m) => `${m.varName}=${m.id}`).join(", ")}`);
    }
    return outcome(true, `page reachable; all ${results.length} manual anchor(s) still present at block level`);
  });
}

async function probeNotionPagePair(env: Env, pageVars: readonly [string, string]): Promise<ProbeOutcome> {
  const driverKey = env[ENV.notionDriverKey];
  if (!driverKey) return outcome(false, `no ${ENV.notionDriverKey} available to read page blocks`);
  return safe("notion soak page-block reads (pair)", async () => {
    const results = await Promise.all(
      pageVars.map(async (name) => {
        const pageId = roomIdFor(name, env)!;
        const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=1`, {
          headers: { authorization: `Bearer ${driverKey}`, "notion-version": "2022-06-28" },
        });
        const json = (await res.json().catch(() => ({}))) as { object?: string; message?: string };
        return { name, pageId, ok: res.ok && json.object !== "error", error: json.message };
      }),
    );
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) return outcome(false, `page-block read failed for: ${bad.map((b) => `${b.name}=${b.pageId} (${b.error ?? "unreachable"})`).join("; ")}`);
    return outcome(true, `page-block reads ok on both: ${results.map((r) => `${r.name}=${r.pageId}`).join(", ")}`);
  });
}

async function probeLinearLabel(env: Env, labelVar: string): Promise<ProbeOutcome> {
  const apiKey = env[ENV.linearSoakDriverKey];
  if (!apiKey) return outcome(false, `no ${ENV.linearSoakDriverKey} available to resolve the soak label`);
  return safe("linear soak label resolve", async () => {
    const labelId = env[labelVar]!;
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: `query($id:String!){ issueLabel(id:$id) { id name team { id name } } }`, variables: { id: labelId } }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { issueLabel?: { id?: string; name?: string; team?: { name?: string } } }; errors?: { message?: string }[] };
    if (!res.ok || json.errors) return outcome(false, `linear graphql failed: ${json.errors?.map((e) => e.message).join("; ") ?? `http ${res.status}`}`);
    if (!json.data?.issueLabel?.id) return outcome(false, `linear graphql — label ${labelId} did not resolve (deleted?)`);
    return outcome(true, `label "${json.data.issueLabel.name ?? labelId}" resolves on team "${json.data.issueLabel.team?.name ?? "?"}"`);
  });
}

async function probe(classified: ClassifiedFixture, env: Env): Promise<{ probe?: ProbeOutcome; notProbed?: string }> {
  const f = classified.family;
  switch (f.probe) {
    case "presence-only":
      return { notProbed: f.presenceOnlyReason ?? "presence-only family — no vendor to reach" };
    case "slack-base":
      return { probe: await probeSlackBase(env) };
    case "slack-secondary":
      return { probe: await probeSlackSecondary(env) };
    case "slack-user":
      return { probe: await probeSlackUser(env) };
    case "slack-channel":
      return { probe: await probeSlackChannel(env, f.channelVar!) };
    case "slack-dm-channel":
      return { probe: await probeSlackDmChannel(env, f.channelVar!) };
    case "slack-channel-pair":
      return { probe: await probeSlackChannelPair(env, f.channelVars!) };
    case "discord-base":
      return { probe: await probeDiscordBase(env) };
    case "teams":
      return { probe: await probeTeams(env) };
    case "github":
      return { probe: await probeGithub(env) };
    case "github-pr":
      return { probe: await probeGithubPr(env) };
    case "github-repo":
      return { probe: await probeGithubRepo(env, f.repoVar!) };
    case "linear":
      return { probe: await probeLinear(env) };
    case "notion-ambient":
      return { probe: await probeNotionAmbient(env) };
    case "notion-page-pair":
      return { probe: await probeNotionPagePair(env, f.pageVars!) };
    case "linear-label":
      return { probe: await probeLinearLabel(env, f.labelVar!) };
  }
}

const INVENTORY_COMMANDS = new Set(["inventory", "provision", "provision-mpim", "provision-notion-query-page"]);

async function main(): Promise<void> {
  if (args.length > 0 && INVENTORY_COMMANDS.has(args[0])) {
    if (args.includes("--if-armed") && process.env.E2E_FIXTURE_TABLE_CHECK?.trim() !== "1") {
      console.log("~ e2e:fixtures: not armed. Set E2E_FIXTURE_TABLE_CHECK=1 with the e2e credentials to compare docs/dev/e2e-fixtures.md against the live rooms.");
      process.exit(0);
    }
    const { main: inventoryMain } = await import("./fixture-inventory.js");
    process.exit(await inventoryMain(args));
  }
  const env = process.env;
  const classified = classifyAll(env, FIXTURE_FAMILIES);
  const findings: FixtureFinding[] = [];
  for (const c of classified) {
    if (c.classification !== "set") {
      findings.push({ classified: c });
      continue;
    }
    const { probe: p, notProbed } = await probe(c, env);
    findings.push({ classified: c, probe: p, notProbed });
  }
  const result = fixtureDoctorResult(findings);
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of renderFixtureReport(result)) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`✗ e2e:fixtures: could not complete — ${String(err instanceof Error ? err.message : err)}`);
  process.exit(2);
});
