import { createRequire } from "node:module";
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

type Ev = { type: string; scope?: { turnId?: string }; data: Record<string, unknown> };
function content(turnId: string | undefined, phase: "reply" | "narration", value: string, extra: Record<string, unknown> = {}): Ev {
  return { type: "content.completed", ...(turnId ? { scope: { turnId } } : {}), data: { partId: `p_${turnId ?? "none"}`, kind: "text", phase, value, ...extra } };
}
function settled(turnId: string | undefined, outcome: "completed" | "failed" | "cancelled" = "completed"): Ev {
  return { type: "turn.settled", ...(turnId ? { scope: { turnId } } : {}), data: { ...(turnId ? { turnId } : {}), outcome } };
}

{
  const seen: { phase: unknown; value: unknown; turnId: unknown }[] = [];
  let ownTurnSettled = 0;
  const fake = {
    routes: [],
    adapter: {
      "content.completed": async (event: Ev) => {
        seen.push({ phase: event.data.phase, value: event.data.value, turnId: event.scope?.turnId });
      },
      "turn.settled": async () => {
        ownTurnSettled++;
      },
    },
  };
  const wrapped = withEndsTurnFinalChannel(fake) as unknown as { adapter: Record<string, (d: unknown, c: unknown) => Promise<unknown>> };
  ok((wrapped.adapter as Record<string, unknown>)[ENDS_TURN_FINAL_MARK] === true, "§1 the wrapped adapter carries the wiring mark");

  await inSession(async () => {
    await wrapped.adapter["turn.settled"]!(settled("turn_a"), {});
    await wrapped.adapter["turn.settled"]!(settled("turn_a"), {});
    ok(ownTurnSettled === 2, "§1a the channel's OWN turn.settled still runs every time");
    ok(seen.length === 1, `§1a 🔴 an endsTurn turn is decided EXACTLY ONCE at turn.settled — got ${seen.length}`);
    ok(seen[0]?.phase === "reply" && seen[0]?.value === "" && seen[0]?.turnId === "turn_a", "§1a …with an empty reply part");

    await wrapped.adapter["content.completed"]!(content("turn_b", "reply", "NO_REPLY"), {});
    await wrapped.adapter["turn.settled"]!(settled("turn_b"), {});
    ok(seen.filter((s) => s.turnId === "turn_b").length === 1, "§1b NEGATIVE CONTROL: a text-decided turn is not decided again at turn.settled");

    await wrapped.adapter["content.completed"]!(content("turn_c", "narration", "thinking"), {});
    await wrapped.adapter["turn.settled"]!(settled("turn_c"), {});
    ok(seen.filter((s) => s.turnId === "turn_c" && s.value === "").length === 1, "§1c a narration part leaves the turn undecided, so turn.settled decides it");

    await wrapped.adapter["content.completed"]!({ type: "content.completed", scope: { turnId: "turn_r" }, data: { partId: "r", kind: "reasoning", phase: "reply", value: "why" } }, {});
    await wrapped.adapter["turn.settled"]!(settled("turn_r"), {});
    ok(seen.filter((s) => s.turnId === "turn_r" && s.value === "").length === 1, "§1r a reasoning part never decides the turn — turn.settled decides it");

    notePendingDelegation("turn_d", "agent-d1", "wake-d");
    await wrapped.adapter["content.completed"]!(content("turn_d", "reply", "let me check"), {});
    ok(seen.filter((s) => s.turnId === "turn_d").length === 0, "§1d 🔴 pre-wait text never reaches the channel's handler — it is not a final message");
    noteDelegationSettled("turn_d", "agent-d1");
    await wrapped.adapter["turn.settled"]!(settled("turn_d"), {});
    ok(seen.filter((s) => s.turnId === "turn_d").length === 1, "§1d 🔴 …and the turn is decided EXACTLY ONCE, at turn.settled");

    notePendingDelegation("turn_d2", "agent-d2", "wake-d2");
    await wrapped.adapter["turn.settled"]!(settled("turn_d2"), {});
    ok(seen.filter((s) => s.turnId === "turn_d2").length === 1, "§1d2 a stale pending entry never leaves an ENDED turn undecided");

    await wrapped.adapter["content.completed"]!(content("turn_g", "reply", "Here is the summ", { interrupted: true }), {});
    await wrapped.adapter["turn.settled"]!(settled("turn_g"), {});
    ok(seen.filter((s) => s.turnId === "turn_g").length === 1, "§1g 🔴 an interrupted reply is decided EXACTLY ONCE — turn.settled does not decide it again");

    await wrapped.adapter["turn.settled"]!(settled("turn_f", "failed"), {});
    await wrapped.adapter["turn.settled"]!(settled("turn_x", "cancelled"), {});
    ok(seen.filter((s) => s.turnId === "turn_f" || s.turnId === "turn_x").length === 0, "§1i a failed or cancelled turn.settled decides nothing (only a completed turn did before)");

    const before = seen.length;
    await wrapped.adapter["turn.settled"]!(settled(undefined), {});
    ok(seen.length === before, "§1e a turn.settled with no turn id decides nothing rather than risk deciding twice");
  });

  {
    const decided: unknown[] = [];
    const throwing = withEndsTurnFinalChannel({
      adapter: {
        "content.completed": async (event: Ev) => {
          decided.push(event.scope?.turnId);
        },
        "turn.settled": async () => {
          throw new Error("status call rate-limited");
        },
      },
    }) as unknown as { adapter: Record<string, (d: unknown, c: unknown) => Promise<unknown>> };
    await inSession(async () => {
      await throwing.adapter["turn.settled"]!(settled("turn_h"), {});
    });
    ok(decided.length === 1 && decided[0] === "turn_h", "§1h 🔴 a throwing channel turn.settled does not cost the final-message decision");
  }

  const bare = { adapter: {} };
  ok(withEndsTurnFinalChannel(bare) === bare, "§1f a channel with no content.completed is returned unchanged");
}

console.log(`✓ ends-turn-final §1: ${passed} assertions passed`);

for (const [name, load] of [
  ["slack", () => import("../packages/providers/slack/agent/channels/slack.js")],
  ["discord", () => import("../packages/providers/discord/agent/channels/discord.js")],
  ["discord-gateway", () => import("../packages/providers/discord/agent/channels/discord-gateway.js")],
  ["teams", () => import("../packages/providers/teams/agent/channels/teams.js")],
  ["github", () => import("../packages/providers/github/agent/channels/github.js")],
  ["notion", () => import("../packages/providers/notion/agent/channels/notion.js")],
  ["linear", () => import("../packages/providers/linear/agent/channels/linear.js")],
] as const) {
  // A literal import per channel: the chain runner resolves a literal specifier, not a variable one.
  const channel = ((await load()) as { default: unknown }).default;
  const adapter = (channel as { adapter?: Record<string, unknown> }).adapter;
  ok(adapter?.[ENDS_TURN_FINAL_MARK] === true, `§2 🔴 the ${name} channel's export carries the endsTurn final-message wrap`);
  ok(typeof adapter?.["turn.settled"] === "function", `§2 …and its adapter has a turn.settled handler (${name})`);
}
{
  const unified = (await import("../packages/core/agent/channels/unified.js")).default as unknown as { adapter: Record<string, unknown> };
  ok(typeof unified.adapter["turn.settled"] === "function", "§2 the unified seat has its own turn.settled decision");
}

console.log(`✓ ends-turn-final: ${passed} assertions passed`);
process.exit(0);
