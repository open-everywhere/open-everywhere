import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-wake-retry-parity-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";

import { divertToUnifiedWindow } from "@open-everywhere/core/agent/channels/unified.js";
import { formatWindowToken } from "@open-everywhere/core/agent/channels/window-key.js";
import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { WAKE_RETRY_ACTION } from "@open-everywhere/core/agent/channels/wake-timing.js";
import type { RouteHandlerArgs } from "eve/channels";
import { posixRelative } from "./posix-path.js";

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("wake-retry-parity:");

const SURFACES: ReadonlyArray<{
  readonly platform: string;
  readonly frontDoor: string;
  readonly origin: Record<string, unknown>;
}> = [
  { platform: "slack", frontDoor: "packages/providers/slack/agent/channels/slack-front.ts", origin: { platform: "slack", channelId: "C042WIN" } },
  { platform: "discord", frontDoor: "packages/providers/discord/agent/channels/discord-gateway.ts", origin: { platform: "discord", channelId: "CH_WIN", guildId: "G_WIN" } },
  {
    platform: "teams",
    frontDoor: "packages/providers/teams/agent/channels/teams-front.ts",
    origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "19:winchan@thread.tacv2;messageid=1712" },
  },
  { platform: "github", frontDoor: "packages/providers/github/agent/channels/github.ts", origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 } },
  { platform: "linear", frontDoor: "packages/providers/linear/agent/channels/linear.ts", origin: { platform: "linear", agentSessionId: "as-lin-77", issueId: "issue-uuid-77" } },
  { platform: "notion", frontDoor: "packages/providers/notion/agent/channels/notion.ts", origin: { platform: "notion", discussionId: "disc-win-1" } },
];

const FUNNEL = /\bdivert(?:Inbound)?ToUnifiedWindow\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(posixRelative(root, full));
  }
  return out;
}

console.log("1. every surface reaches the shared dispatch:");
{
  for (const s of SURFACES) {
    const src = readFileSync(join(root, s.frontDoor), "utf8");
    ok(FUNNEL.test(src), `🔴 §1 ${s.platform}: its wake front door still dispatches through divertToUnifiedWindow — the ONE send the backoff wraps`);
  }

  const callers = sourceFiles(join(root, "packages/providers"))
    .filter((f) => f.includes("/agent/") && !f.includes("/scripts/") && !f.endsWith("docs-generated.ts"))
    .filter((f) => FUNNEL.test(readFileSync(join(root, f), "utf8")))
    .sort();
  eq(
    callers,
    SURFACES.map((s) => s.frontDoor).sort(),
    "🔴 §1: the provider modules that CALL the funnel are EXACTLY the six front doors — a seventh is a module whose wakes nobody proved are on this road",
  );
}

{
  const NATIVE_SENDS: ReadonlyArray<{ readonly platform: string; readonly file: string; readonly launches: number }> = [
    { platform: "slack", file: "packages/providers/slack/agent/channels/slack-events.ts", launches: 3 },
    { platform: "github", file: "packages/providers/github/agent/channels/github.ts", launches: 1 },
    { platform: "linear", file: "packages/providers/linear/agent/channels/linear.ts", launches: 1 },
    { platform: "notion", file: "packages/providers/notion/agent/channels/notion.ts", launches: 1 },
    { platform: "discord", file: "packages/providers/discord/agent/channels/discord-gateway.ts", launches: 1 },
  ];
  for (const e of NATIVE_SENDS) {
    const src = readFileSync(join(root, e.file), "utf8");
    const launches = src.match(/\bdispatchNativeWakeWithRetry\s*\(/g)?.length ?? 0;
    eq(launches, e.launches, `🔴 §1b ${e.platform}: every native launch closure uses the ONE shared native retry road`);
  }
  eq(NATIVE_SENDS.length, 5, "🔴 §1b: exactly FIVE surfaces have a native road; Teams has none");

  const teams = readFileSync(join(root, "packages/providers/teams/agent/channels/teams-front.ts"), "utf8");
  ok(
    /\bdivertInboundToUnifiedWindow\s*\(/.test(teams) && !/\bdispatchNativeWakeWithRetry\s*\(/.test(teams) && !teams.includes("if (!input.window) {"),
    "🔴 §1b (positive control): Teams still has NO native branch — every Teams wake diverts, which is why it is the one surface fully on this road",
  );
}

console.log("2. a rate-limited wake is retried on every surface:");

function queueRefusal(): Error {
  const err = new Error("Too many requests — please retry later");
  err.name = "TooManyRequestsError";
  return err;
}

function scriptedReceive(script: ReadonlyArray<Error | "delivered">): { to: RouteHandlerArgs["to"]; calls: () => number } {
  let calls = 0;
  const to = ((_channel: unknown, _target: unknown) => ({
    async send(): Promise<void> {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
    },
  })) as unknown as RouteHandlerArgs["to"];
  return { to, calls: () => calls };
}

async function retryRows(wakeId: string): Promise<Array<{ platform: string; detail: Record<string, unknown> }>> {
  const rows = await readAudit({ org: deploymentOrg(), action: WAKE_RETRY_ACTION });
  return rows
    .map((r) => ({ platform: String(r.platform), detail: r.detail as Record<string, unknown> }))
    .filter((r) => r.detail["wakeId"] === wakeId);
}

async function wake(s: (typeof SURFACES)[number], wakeId: string, to: RouteHandlerArgs["to"]): Promise<unknown> {
  const domain = `dom-${s.platform}`;
  try {
    await divertToUnifiedWindow(to, {
      message: "<wake>the payout cutoff, please</wake>",
      token: formatWindowToken({ domain, windowId: domain, generation: 1 }),
      window: { wakeId, origin: s.origin as never, addressing: "direct-mention" },
      surfaceKey: `${s.platform}/W1/C1`,
      auth: { attributes: {} },
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

for (const s of SURFACES) {
  const wakeId = `w-retry-${s.platform}`;
  const { to, calls } = scriptedReceive([queueRefusal(), "delivered"]);
  const threw = await wake(s, wakeId, to);

  ok(threw === undefined, `🔴 §2 ${s.platform}: a wake refused ONCE is not dropped — the dispatch resolves, so the turn starts`);
  eq(calls(), 2, `🔴 §2 ${s.platform}: the dispatch was repeated exactly once`);

  const rows = await retryRows(wakeId);
  eq(rows.length, 1, `🔴 §2 ${s.platform}: the refusal left exactly one surface.wake_retry row`);
  eq(rows[0]?.platform, s.platform, `🔴 §2 ${s.platform}: …partitioned to THIS surface, built from the wake's own origin`);
  eq(rows[0]?.detail["attempt"], 1, `§2 ${s.platform}: …naming the attempt that was refused`);
  eq(rows[0]?.detail["outcome"], "retrying", `§2 ${s.platform}: …and that it was retried`);
  eq(rows[0]?.detail["surfaceKey"], `${s.platform}/W1/C1`, `§2 ${s.platform}: …under the surface key whose member is waiting`);
}

console.log("3. and no surface retries what must not be retried:");
for (const s of SURFACES) {
  const wakeId = `w-transport-${s.platform}`;
  const { to, calls } = scriptedReceive([new Error("socket hang up"), "delivered"]);
  const threw = await wake(s, wakeId, to);
  ok(threw instanceof Error && threw.message === "socket hang up", `🔴 §3 ${s.platform}: a transport throw propagates unchanged on the FIRST attempt`);
  eq(calls(), 1, `🔴 §3 ${s.platform}: …and is never repeated — an unanswered request may already have woken the seat`);
  eq((await retryRows(wakeId)).length, 0, `🔴 §3 ${s.platform}: …and writes no retry row`);
}

console.log(
  `✓ wake-retry-parity: ${n} assertions passed across ${SURFACES.length} surfaces (every windowed front door reaches the funnel, all five native topology-off launch modules use the shared native retry road with Teams as the positive control, the retry works per surface and audits as itself, and no surface retries a transport throw)`,
);
