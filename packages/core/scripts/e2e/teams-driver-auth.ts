import { ENV, TEAMS_AUTH_NEXT_STEP, teamsRefreshSinkPath, teamsSecondaryRefreshSinkPath } from "./env.js";
import { sleep } from "./poll.js";
import { writeRefreshSidecar } from "./teams-driver.js";

const TOKEN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES =
  "ChannelMessage.Send ChannelMessage.Read.All Team.ReadBasic.All Channel.ReadBasic.All offline_access";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in?: number;
  message?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function requestDeviceCode(tenantId: string, clientId: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${TOKEN_BASE}/${tenantId}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as DeviceCodeResponse & { error?: string; error_description?: string };
  if (!res.ok || !json.device_code) {
    die(`✗ device-code request failed: ${json.error_description ?? json.error ?? `http ${res.status}`}`);
  }
  return json;
}

async function pollForToken(tenantId: string, clientId: string, device: DeviceCodeResponse): Promise<TokenResponse> {
  let intervalMs = (device.interval ?? 5) * 1_000;
  const deadline = Date.now() + (device.expires_in ?? 900) * 1_000;
  for (;;) {
    if (Date.now() >= deadline) die("✗ device code expired before you finished signing in — re-run the helper.");
    await sleep(intervalMs);
    const res = await fetch(`${TOKEN_BASE}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: device.device_code,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (res.ok && json.access_token && json.refresh_token) return json;
    switch (json.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5_000;
        continue;
      case "expired_token":
        die("✗ device code expired before you finished signing in — re-run the helper.");
        break;
      case "authorization_declined":
        die("✗ sign-in was declined in the browser — re-run the helper if that was a mistake.");
        break;
      default:
        die(`✗ token poll failed: ${json.error_description ?? json.error ?? `http ${res.status}`}`);
    }
  }
}

const ID_FALLBACK_HINT =
  "\nTo get E2E_TEAMS_TEAM_ID / E2E_TEAMS_CHANNEL_ID by hand: in Teams, hover the channel →\n" +
  "  ⋯ → 'Get link to channel'. The link is\n" +
  "  …/channel/19%3A…%40thread.tacv2/Name?groupId=<GUID>&tenantId=…\n" +
  "  → groupId (the GUID) is E2E_TEAMS_TEAM_ID; the URL-DECODED 19:…@thread.tacv2 is E2E_TEAMS_CHANNEL_ID.";

async function listTeamsAndChannels(accessToken: string): Promise<void> {
  const auth = { authorization: `Bearer ${accessToken}` };
  try {
    const res = await fetch(`${GRAPH_BASE}/me/joinedTeams`, { headers: auth });
    if (!res.ok) {
      console.log(`\n(could not list joined teams — http ${res.status}; the refresh token above is still valid.)`);
      console.log(ID_FALLBACK_HINT);
      return;
    }
    const teams = ((await res.json()) as { value?: { id?: string; displayName?: string }[] }).value ?? [];
    if (teams.length === 0) {
      console.log("\n(no joined teams found for this user — make sure the test user is a member of the team OE is installed in.)");
      return;
    }
    console.log("\nTeams you belong to (copy the ids into E2E_TEAMS_TEAM_ID / E2E_TEAMS_CHANNEL_ID):");
    for (const team of teams) {
      if (!team.id) continue;
      console.log(`  team: ${team.displayName ?? "(unnamed)"} (${team.id})`);
      const chRes = await fetch(`${GRAPH_BASE}/teams/${team.id}/channels`, { headers: auth });
      if (!chRes.ok) {
        console.log(`    (could not list channels — http ${chRes.status})`);
        continue;
      }
      const channels = ((await chRes.json()) as { value?: { id?: string; displayName?: string }[] }).value ?? [];
      for (const ch of channels) {
        console.log(`    channel: ${ch.displayName ?? "(unnamed)"} (${ch.id ?? "?"})`);
      }
    }
  } catch (err) {
    console.log(`\n(team/channel listing skipped: ${String(err instanceof Error ? err.message : err)} — the refresh token above is still valid.)`);
    console.log(ID_FALLBACK_HINT);
  }
}

async function main(): Promise<void> {
  const tenantId = process.env[ENV.teamsTenantId]?.trim();
  const clientId = process.env[ENV.teamsClientId]?.trim();
  if (!tenantId || !clientId) {
    die(
      `✗ set ${ENV.teamsTenantId} and ${ENV.teamsClientId} first.\n` +
        `  ${ENV.teamsTenantId} = your Microsoft tenant (Directory) id\n` +
        `  ${ENV.teamsClientId} = the Teams driver's Entra app registration client id (a PUBLIC client:\n` +
        `      "Allow public client flows" ON, delegated Graph perms ChannelMessage.Send +\n` +
        `      ChannelMessage.Read.All + offline_access, admin-consented). See docs/deploy/surfaces/teams.md.`,
    );
  }
  const secondary = process.argv.includes("--secondary");
  const tokenVar = secondary ? ENV.teamsSecondaryRefreshToken : ENV.teamsRefreshToken;
  let sink: string;
  try {
    sink = secondary ? teamsSecondaryRefreshSinkPath() : teamsRefreshSinkPath();
    if (secondary && sink === teamsRefreshSinkPath()) die(`✗ ${ENV.teamsSecondaryRefreshTokenFile} names the base sidecar ${sink} — give the second user a file of its own.`);
  } catch (err) {
    die(`✗ cannot place the refresh sidecar: ${String(err instanceof Error ? err.message : err)}`);
  }

  console.log(`Requesting a device code for tenant ${tenantId}…`);
  const device = await requestDeviceCode(tenantId, clientId);
  console.log(`\n${device.message ?? `To sign in, open ${device.verification_uri} and enter the code ${device.user_code}`}\n`);
  console.log(
    secondary
      ? "Waiting for you to complete sign-in in the browser — sign in as the SECOND test user, a member of the same team who is NOT the driver user…"
      : "Waiting for you to complete sign-in in the browser…",
  );

  const token = await pollForToken(tenantId, clientId, device);
  console.log("\n✓ signed in — refresh token minted.\n");
  console.log("Set this in your shell / CI secrets (NEVER commit it):\n");
  console.log(`export ${tokenVar}='${token.refresh_token}'\n`);

  if (token.refresh_token) {
    writeRefreshSidecar(sink, token.refresh_token);
    console.log(`(Also written to the gitignored sidecar ${sink} — the driver self-heals rotation from there, so this mint is one-time.)\n`);
  }

  if (token.access_token) await listTeamsAndChannels(token.access_token);

  if (secondary) {
    console.log(`\nNext: set ${ENV.teamsSecondaryRefreshToken} beside the six base Teams vars and run: E2E_ONLY=S-COVER-teams npm run test:e2e-driver`);
    return;
  }
  console.log(
    `\nNext: set the six ${ENV.teamsTenantId.replace("_TENANT_ID", "_*")} vars (tenant, client, refresh, team, channel, bot app id) ` +
      `and run: ${TEAMS_AUTH_NEXT_STEP}`,
  );
}

main().catch((err) => {
  console.error(`✗ teams auth helper crashed: ${String(err instanceof Error ? err.message : err)}`);
  process.exit(1);
});
