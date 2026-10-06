import { createRequire } from "node:module";
import slackChannelExport from "../packages/providers/slack/agent/channels/slack.js";
import discordChannelExport from "../packages/providers/discord/agent/channels/discord.js";
import discordGatewayChannelExport from "../packages/providers/discord/agent/channels/discord-gateway.js";
import teamsChannelExport from "../packages/providers/teams/agent/channels/teams.js";
import githubChannelExport from "../packages/providers/github/agent/channels/github.js";
import notionChannelExport from "../packages/providers/notion/agent/channels/notion.js";
import linearChannelExport from "../packages/providers/linear/agent/channels/linear.js";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { withEndsTurnFinalChannel, ENDS_TURN_FINAL_MARK } = await import("../packages/core/agent/channels/ends-turn-final.js");
const { notePendingDelegation, noteDelegationSettled } = await import("../packages/core/agent/access/pending-delegation-signal.js");

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function inSession<T>(fn: () => Promise<T>): Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "ends-turn-final-test", auth: null, turn: 1, parent: undefined });
  return contextStorage.run(c, fn);
}

{
  const seen: { finishReason: unknown; message: unknown; turnId: unknown }[] = [];
  let ownTurnCompleted = 0;
  const fake = {
    routes: [],
    adapter: {
      "message.completed": async (data: { finishReason: unknown; message: unknown; turnId: unknown }) => {
        seen.push({ finishReason: data.finishReason, message: data.message, turnId: data.turnId });
      },
      "turn.completed": async () => {
        ownTurnCompleted++;
      },
    },
  };
  const wrapped = withEndsTurnFinalChannel(fake) as unknown as { adapter: Record<string, (d: unknown, c: unknown) => Promise<unknown>> };
  ok((wrapped.adapter as Record<string, unknown>)[ENDS_TURN_FINAL_MARK] === true, "§1 the wrapped adapter carries the wiring mark");

  await inSession(async () => {
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_a", sequence: 3 }, {});
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_a", sequence: 3 }, {});
    ok(ownTurnCompleted === 2, "§1a the channel's OWN turn.completed still runs every time");
    ok(seen.length === 1, `§1a 🔴 an endsTurn turn is decided EXACTLY ONCE at turn.completed — got ${seen.length}`);
    ok(seen[0]?.finishReason === "stop" && seen[0]?.message === "" && seen[0]?.turnId === "turn_a", "§1a …with the empty stop message the retired empty step carried");

    await wrapped.adapter["message.completed"]!({ finishReason: "stop", message: "NO_REPLY", turnId: "turn_b" }, {});
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_b", sequence: 4 }, {});
    ok(seen.filter((s) => s.turnId === "turn_b").length === 1, "§1b NEGATIVE CONTROL: a text-decided turn is not decided again at turn.completed");

    await wrapped.adapter["message.completed"]!({ finishReason: "tool-calls", message: "thinking", turnId: "turn_c" }, {});
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_c", sequence: 5 }, {});
    ok(seen.filter((s) => s.turnId === "turn_c" && s.message === "").length === 1, "§1c a tool-calls completion leaves the turn undecided, so turn.completed decides it");

    notePendingDelegation("turn_d", "agent-d1", "wake-d");
    await wrapped.adapter["message.completed"]!({ finishReason: "stop", message: "let me check", turnId: "turn_d" }, {});
    ok(seen.filter((s) => s.turnId === "turn_d").length === 0, "§1d 🔴 pre-wait text never reaches the channel's handler — it is not a final message");
    noteDelegationSettled("turn_d", "agent-d1");
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_d", sequence: 6 }, {});
    ok(seen.filter((s) => s.turnId === "turn_d").length === 1, "§1d 🔴 …and the turn is decided EXACTLY ONCE, at turn.completed");

    notePendingDelegation("turn_d2", "agent-d2", "wake-d2");
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_d2", sequence: 6 }, {});
    ok(seen.filter((s) => s.turnId === "turn_d2").length === 1, "§1d2 a stale pending entry never leaves an ENDED turn undecided");

    await wrapped.adapter["message.completed"]!({ finishReason: "length", message: "Here is the summ", turnId: "turn_g" }, {});
    await wrapped.adapter["turn.completed"]!({ turnId: "turn_g", sequence: 8 }, {});
    ok(seen.filter((s) => s.turnId === "turn_g").length === 1, "§1g 🔴 a `length` ending is decided EXACTLY ONCE — turn.completed does not decide it again");

    const before = seen.length;
    await wrapped.adapter["turn.completed"]!({ sequence: 7 }, {});
    ok(seen.length === before, "§1e a turn.completed with no turn id decides nothing rather than risk deciding twice");
  });

  {
    const decided: unknown[] = [];
    const throwing = withEndsTurnFinalChannel({
      adapter: {
        "message.completed": async (data: { turnId: unknown }) => {
          decided.push(data.turnId);
        },
        "turn.completed": async () => {
          throw new Error("status call rate-limited");
        },
      },
    }) as unknown as { adapter: Record<string, (d: unknown, c: unknown) => Promise<unknown>> };
    await inSession(async () => {
      await throwing.adapter["turn.completed"]!({ turnId: "turn_h", sequence: 1 }, {});
    });
    ok(decided.length === 1 && decided[0] === "turn_h", "§1h 🔴 a throwing channel turn.completed does not cost the final-message decision");
  }

  const bare = { adapter: {} };
  ok(withEndsTurnFinalChannel(bare) === bare, "§1f a channel with no message.completed is returned unchanged");
}

for (const [name, channel] of [
  ["slack", slackChannelExport],
  ["discord", discordChannelExport],
  ["discord-gateway", discordGatewayChannelExport],
  ["teams", teamsChannelExport],
  ["github", githubChannelExport],
  ["notion", notionChannelExport],
  ["linear", linearChannelExport],
] as const) {
  const adapter = (channel as { adapter?: Record<string, unknown> }).adapter;
  ok(adapter?.[ENDS_TURN_FINAL_MARK] === true, `§2 🔴 the ${name} channel's export carries the endsTurn final-message wrap`);
  ok(typeof adapter?.["turn.completed"] === "function", `§2 …and its adapter has a turn.completed handler (${name})`);
}
{
  const unified = (await import("../packages/core/agent/channels/unified.js")).default as unknown as { adapter: Record<string, unknown> };
  ok(typeof unified.adapter["turn.completed"] === "function", "§2 the unified seat has its own turn.completed decision");
}

console.log(`✓ ends-turn-final: ${passed} assertions passed`);
process.exit(0);
