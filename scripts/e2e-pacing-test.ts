import assert from "node:assert/strict";
import {
  PACED_DRIVER_METHODS,
  createPacingGate,
  paceDriver,
  paceMaybe,
  renderPacingLine,
  type PacingClock,
} from "../packages/core/scripts/e2e/pacing.js";
import { slackUnifiedCoalescingBurst, slackUnifiedPrimedCoalescingBurst } from "../packages/core/scripts/e2e/coalesced-burst.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";
import { PACING_CHANNEL_FLOOR_MS, PACING_MAX_CONCURRENT_PER_SURFACE } from "../packages/core/scripts/e2e/env.js";
import { SlackDriver } from "../packages/core/scripts/e2e/slack-driver.js";
import { DiscordDriver } from "../packages/core/scripts/e2e/discord-driver.js";
import { TeamsDriver } from "../packages/core/scripts/e2e/teams-driver.js";
import { GithubDriver } from "../packages/core/scripts/e2e/github-driver.js";
import { LinearDriver } from "../packages/core/scripts/e2e/linear-driver.js";
import { NotionDriver } from "../packages/core/scripts/e2e/notion-driver.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

function fakeClock(): PacingClock & { readonly slept: number[]; settle(): Promise<void> } {
  let t = 0;
  const slept: number[] = [];
  const timers: { at: number; resolve: () => void }[] = [];
  return {
    slept,
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      return new Promise<void>((resolve) => timers.push({ at: t + ms, resolve }));
    },
    async settle(): Promise<void> {
      for (;;) {
        await new Promise((r) => setImmediate(r));
        if (timers.length === 0) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.resolve();
      }
    },
  };
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 4, clock });
  const startedAt: number[] = [];
  const record = async (): Promise<void> => {
    startedAt.push(clock.now());
  };

  const work = (async () => {
    await gate.drive("slack", "C1", record);
    await gate.drive("slack", "C1", record);
    await gate.drive("slack", "C1", record);
  })();
  await clock.settle();
  await work;

  ok(startedAt.length === 3, "all three drives ran — the gate delays, it never drops");
  ok(startedAt[0] === 0, "the first drive on a fresh channel is not delayed at all");
  ok(startedAt[1] === 1_000, "🔴 the SECOND drive on the same channel starts exactly one floor later");
  ok(startedAt[2] === 2_000, "…and the third is spaced by another floor, so the spacing is per-drive, not one-off");
  ok(
    clock.slept.filter((ms) => ms > 0).length === 2,
    "the gate slept exactly twice — the first drive waits for nothing, so a third sleep would mean it paced a drive that needed none",
  );
  ok(gate.stats().waitedMs === 2_000, "the reported cost equals the time actually held back");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 4, clock });
  const startedAt: number[] = [];
  const record = async (): Promise<void> => {
    startedAt.push(clock.now());
  };
  const work = (async () => {
    await gate.drive("slack", "C1", record);
    await gate.drive("slack", "C1", record);
    await gate.drive("slack", "C1", record);
  })();
  await clock.settle();
  await work;
  ok(
    startedAt.length === 3 && startedAt.every((t) => t === 0),
    "🔴 NEGATIVE CONTROL: with floorMs 0 every drive starts at 0 — so the spacing above came from the floor and not from the clock advancing on its own",
  );
  ok(gate.stats().waitedMs === 0, "…and nothing was held back");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const startedAt: Record<string, number> = {};
  const work = (async () => {
    await gate.driveBurst("slack", ["CA", "CB"], async () => {
      startedAt.A = clock.now();
      startedAt.B = clock.now();
    });
    await gate.drive("slack", "CA", async () => {
      startedAt.nextA = clock.now();
    });
    await gate.drive("slack", "CB", async () => {
      startedAt.nextB = clock.now();
    });
  })();
  await clock.settle();
  await work;
  ok(startedAt.A === 0 && startedAt.B === 0, "OPE-1913: the explicitly paired rooms run in one burst with no floor between them, so the pacer does not make coalescing impossible");
  ok(startedAt.nextA === 1_000 && startedAt.nextB === 1_000, "the burst consumes each room's ordinary floor; later drives are still paced");
  ok(gate.stats().totalDrives === 4, "the burst reports both vendor posts plus both later drives — the pacing report does not hide the exception");
  ok(gate.stats().drivesPerChannel.get("slack/CA") === 2 && gate.stats().drivesPerChannel.get("slack/CB") === 2, "burst accounting remains per channel");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const order: string[] = [];
  let calls = 0;
  const work = gate.driveBurst("slack", ["CA", "CB"], async () => {
    calls++;
    order.push("ask");
    await new Promise((r) => setImmediate(r));
    order.push("aside");
    return "done";
  });
  await clock.settle();
  ok((await work) === "done", "the burst returns the callback's own value — the gate wraps the drive and decides nothing about it");
  ok(calls === 1, "the gate invoked the callback exactly once");
  ok(order.join(",") === "ask,aside", "🔴 the callback's own ordering survives the burst — the gate never parallelises or reorders the posts inside it");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 4, clock });
  const startedAt: number[] = [];
  const record = async (): Promise<void> => {
    startedAt.push(clock.now());
  };
  const work = (async () => {
    await gate.driveBurst("slack", ["C1"], record);
    await gate.drive("slack", "C1", record);
    await gate.driveBurst("slack", ["C1"], record);
  })();
  await clock.settle();
  await work;
  ok(
    startedAt.length === 3 && startedAt[0] === 0 && startedAt[1] === 1_000 && startedAt[2] === 2_000,
    "🔴 REGRESSION: a SINGLE-room burst paces exactly as `drive` does — the exception is the PAIRING, not a bypass any one-room caller can reach",
  );
  ok(gate.stats().drivesPerChannel.get("slack/C1") === 3 && gate.stats().totalDrives === 3, "…and it is counted as the three drives it is");
  ok(gate.stats().waitedMs === 2_000, "…and it reports the same held-back cost the all-`drive` schedule reports");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const startedAt: Record<string, number> = {};
  let burstDone = false;
  const work = Promise.all([
    gate.driveBurst("slack", ["CA", "CB"], async () => {
      startedAt.burst = clock.now();
      await clock.sleep(5_000);
      burstDone = true;
    }),
    gate.drive("slack", "CC", async () => {
      startedAt.third = clock.now();
      ok(burstDone, "🔴 a third room of the same surface cannot be driven until the burst releases BOTH slots — the burst is capped, never exempt");
    }),
  ]);
  await clock.settle();
  await work;
  ok(startedAt.burst === 0 && startedAt.third === 5_000, "the third room ran only after the burst's own work finished");
  ok(gate.stats().maxConcurrencyPerSurface.get("slack") === 2, "the burst reports the two slots it really held — the pacing line never understates the exception");
}

ok(PACING_MAX_CONCURRENT_PER_SURFACE === 2, "the shipped per-surface cap is 2, which is the size of S-APPROVAL-COALESCED's two-room burst");

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const ran: string[] = [];
  const work = Promise.all([
    gate.driveBurst("slack", ["CA", "CB"], async () => {
      ran.push("first");
      await clock.sleep(1_000);
    }),
    gate.driveBurst("slack", ["CC", "CD"], async () => {
      ran.push("second");
    }),
  ]);
  await clock.settle();
  const outcome = await Promise.race([work.then(() => "settled"), new Promise<string>((r) => setTimeout(() => r("deadlocked"), 250))]);
  ok(outcome === "settled", "🔴 neither burst deadlocks the other — the slots are taken all-or-nothing, so a waiting burst holds none of them");
  ok(ran.length === 2 && ran[0] === "first", "both bursts ran, the first one first");
  ok(gate.stats().totalDrives === 4, "both bursts drove both of their rooms");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const calls: { channel: string; text: string; at: number; settled: number }[] = [];
  let settled = 0;
  const drive = slackUnifiedCoalescingBurst({
    gate,
    channelA: "CASK",
    channelB: "CASIDE",
    post: async (channel, text) => {
      const at = calls.length;
      await new Promise((r) => setImmediate(r));
      calls.push({ channel, text, at, settled: settled++ });
      return { ts: `ts-${channel}` };
    },
  });
  const work = drive("the routine ask", "the aside");
  await clock.settle();
  const out = await work;

  ok(calls.length === 2, "the drive made exactly two vendor posts");
  ok(calls[0]?.channel === "CASK" && calls[0]?.text === "the routine ask", "🔴 the ASK is posted FIRST, into the asking room");
  ok(calls[1]?.channel === "CASIDE" && calls[1]?.text === "the aside", "🔴 the ASIDE is posted SECOND, so it is the last delivery eve can merge — the whole reason the leg reproduces OPE-1756");
  ok(calls[0]!.at === 0 && calls[1]!.at === 1, "🔴 the second post is not even STARTED until the first has returned — a concurrent `Promise.all` would leave the arrival order to the network");
  ok(out.askTs === "ts-CASK", "the drive returns the ASK's ts — the reply the leg waits for is the one in the asking room");
  ok(gate.stats().drivesPerChannel.get("slack/CASK") === 1 && gate.stats().drivesPerChannel.get("slack/CASIDE") === 1, "both rooms are accounted for in the pacing report");
  ok(gate.stats().waitedMs === 0, "…and on a fresh pair of rooms the burst held nothing back: the two posts are back-to-back, which is the coalescing precondition");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  const startedAt: number[] = [];
  const drive = slackUnifiedCoalescingBurst({
    gate,
    channelA: "CASK",
    channelB: "CASIDE",
    post: async () => {
      startedAt.push(clock.now());
      return { ts: "ts" };
    },
  });
  const work = (async () => {
    await drive("ask 1", "aside 1");
    await drive("ask 2", "aside 2");
  })();
  await clock.settle();
  await work;
  ok(startedAt.length === 4, "both attempts drove both rooms");
  ok(startedAt[0] === 0 && startedAt[1] === 0, "attempt 1's two posts are back-to-back");
  ok(startedAt[2] === 1_000 && startedAt[3] === 1_000, "🔴 attempt 2 waits a full floor — the retry the leg makes when the first interleave did not coalesce is still paced");
  ok(gate.stats().waitedMs === 1_000, "…and the cost of that wait is reported");
}

const PRIME_TURN_START: AuditWireEntry = {
  seq: 41,
  ts: "2026-09-20T17:32:20.000Z",
  org: "oe",
  platform: "slack",
  workspace: "e2e-unified",
  surface: "slack/T1/CASK",
  action: "wake.turn_start",
  detail: { wakeId: "wake-prime" },
};

{
  const order: string[] = [];
  let burstRanBeforeTurnStart = false;
  let turnStartResolved = false;
  let releaseTurnStart: (() => void) | undefined;
  const turnStarted = new Promise<void>((r) => { releaseTurnStart = r; });

  const drive = slackUnifiedPrimedCoalescingBurst({
    primePost: async (text) => { order.push(`prime:${text}`); },
    awaitTurnStart: async () => { order.push("await-turn-start"); await turnStarted; turnStartResolved = true; return PRIME_TURN_START; },
    burst: async (askText, asideText) => {
      if (!turnStartResolved) burstRanBeforeTurnStart = true;
      order.push(`burst:${askText}|${asideText}`);
      return { askTs: "ts-CASK" };
    },
  });

  const work = drive("ready?", "the routine ask", "the aside");
  await new Promise((r) => setImmediate(r));
  ok(order.length === 2, `the drive primes and then WAITS — nothing else has run yet (got ${JSON.stringify(order)})`);
  ok(!burstRanBeforeTurnStart, "🔴 the burst has NOT fired while the priming turn's wake.turn_start row is still unseen — an idle-seat burst is the very shape OPE-1948 removes");

  releaseTurnStart!();
  const out = await work;

  ok(order[0] === "prime:ready?", "🔴 the PRIMING post goes first, into the asking room — it is what occupies the seat");
  ok(order[1] === "await-turn-start", "🔴 …then the drive waits for the priming turn's own wake.turn_start row, rather than sleeping and hoping");
  ok(order[2] === "burst:the routine ask|the aside", "🔴 …and only THEN the two-room burst, so both deliveries queue behind a RUNNING turn");
  ok(order.length === 3, `exactly three steps, no more (got ${JSON.stringify(order)})`);
  ok(out.askTs === "ts-CASK", "the drive returns the burst's ASK ts — the reply the leg waits for is still the one in the asking room");
  ok(out.primed === true, "…and reports that the seat was primed, which is what tells a product red from a harness one");
  ok(out.turnStart === PRIME_TURN_START, "🔴 …and hands back the turn-start ROW itself (OPE-2005) — its wakeId is what joins the priming turn to its own reply.post END anchor, and a bare boolean could not");
}

{
  const order: string[] = [];
  const drive = slackUnifiedPrimedCoalescingBurst({
    primePost: async () => { order.push("prime"); },
    awaitTurnStart: async () => { order.push("await-turn-start"); return undefined; },
    burst: async () => { order.push("burst"); return { askTs: "ts-CASK" }; },
  });
  const out = await drive("ready?", "ask", "aside");
  ok(order.join(",") === "prime,await-turn-start,burst", `a priming turn that never started still reaches the burst (got ${JSON.stringify(order)})`);
  ok(out.primed === false, "…and `primed` reports FALSE, so the leg's red names the harness rather than blaming the product");
  ok(out.turnStart === undefined, "…and NO turn-start row comes back, so the flight join has nothing to join on and refuses rather than guessing");
  ok(out.askTs === "ts-CASK", "…and the ask ts still comes back, so the leg can still poll for its reply");
}
{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 2, clock });
  await assert.rejects(() => gate.driveBurst("slack", ["CA", "CB", "CC"], async () => undefined), /exceeds/);
  n++;
  await assert.rejects(() => gate.driveBurst("slack", [], async () => undefined), /at least one channel/);
  n++;
  ok(gate.stats().totalDrives === 0, "a refused burst drives nothing and is counted as nothing");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 4, clock });
  const startedAt: Record<string, number> = {};
  const work = (async () => {
    await gate.drive("slack", "C1", async () => {
      startedAt.C1 = clock.now();
    });
    await gate.drive("slack", "C2", async () => {
      startedAt.C2 = clock.now();
    });
  })();
  await clock.settle();
  await work;
  ok(startedAt.C1 === 0 && startedAt.C2 === 0, "🔴 a drive on a DIFFERENT channel of the same surface waits for nothing — the floor keys on the room, not the platform");
}

{
  const clock = fakeClock();
  const gate = createPacingGate({ floorMs: 1_000, maxConcurrentPerSurface: 8, clock });
  const startedAt: number[] = [];
  const work = Promise.all(
    [0, 1, 2].map(() =>
      gate.drive("slack", "C1", async () => {
        startedAt.push(clock.now());
      }),
    ),
  );
  await clock.settle();
  await work;
  const ordered = [...startedAt].sort((a, b) => a - b);
  ok(
    ordered.length === 3 && ordered[0] === 0 && ordered[1] === 1_000 && ordered[2] === 2_000,
    `🔴 three drives launched TOGETHER on one channel are still spaced one floor apart (started at ${JSON.stringify(ordered)}) — the reservation is taken synchronously, before any await`,
  );
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 2, clock: fakeClock() });
  let live = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const started: number[] = [];

  const launch = (i: number): Promise<void> =>
    gate.drive("slack", `C${i}`, async () => {
      started.push(i);
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((resolve) => release.push(resolve));
      live--;
    });

  const all = [launch(0), launch(1), launch(2), launch(3), launch(4)];
  await new Promise((r) => setImmediate(r));
  ok(started.length === 2, "🔴 THE CAP HOLDS: only two of five drives on one surface entered their body");
  ok(peak === 2, "…and the observed peak never exceeded the cap");

  release.shift()!();
  await new Promise((r) => setImmediate(r));
  ok(started.length === 3, "a released slot admits exactly one waiter — not all of them");

  while (release.length > 0 || started.length < 5) {
    release.shift()?.();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(all);
  ok(started.length === 5, "every drive eventually ran — the cap queues, it never drops");
  ok(peak === 2, "🔴 the peak across the WHOLE run stayed at the cap");
  ok(gate.stats().maxConcurrencyPerSurface.get("slack") === 2, "the gate REPORTS the concurrency it observed, which is what the pacing line prints");
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 8, clock: fakeClock() });
  const release: (() => void)[] = [];
  const started: number[] = [];
  const all = [0, 1, 2, 3, 4].map((i) =>
    gate.drive("slack", `C${i}`, async () => {
      started.push(i);
      await new Promise<void>((resolve) => release.push(resolve));
    }),
  );
  await new Promise((r) => setImmediate(r));
  ok(started.length === 5, "🔴 NEGATIVE CONTROL: with a cap of 8 all five drives enter at once — so the '2' above was the cap, not the scheduler");
  for (const r of release) r();
  await Promise.all(all);
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 1, clock: fakeClock() });
  const release: (() => void)[] = [];
  const started: string[] = [];
  const launch = (surface: string): Promise<void> =>
    gate.drive(surface, "room", async () => {
      started.push(surface);
      await new Promise<void>((resolve) => release.push(resolve));
    });
  const all = [launch("slack"), launch("slack"), launch("discord")];
  await new Promise((r) => setImmediate(r));
  ok(
    started.filter((s) => s === "slack").length === 1 && started.includes("discord"),
    "🔴 one surface at its cap does not hold another back — the semaphore is per surface",
  );
  for (const r of [...release]) r();
  await new Promise((r) => setImmediate(r));
  release.shift()?.();
  while (started.length < 3) {
    release.shift()?.();
    await new Promise((r) => setImmediate(r));
  }
  for (const r of release) r();
  await Promise.all(all);
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 1, clock: fakeClock() });
  await assert.rejects(
    gate.drive("slack", "C1", async () => {
      throw new Error("leg failed");
    }),
    /leg failed/,
  );
  n++;
  let ran = false;
  await gate.drive("slack", "C1", async () => {
    ran = true;
  });
  ok(ran, "🔴 a drive whose body throws still releases its slot — otherwise the first red leg would hang every later drive on that surface");
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 4, clock: fakeClock() });
  const noop = async (): Promise<void> => undefined;
  await gate.drive("slack", "C1", noop);
  await gate.drive("slack", "C1", noop);
  await gate.drive("discord", "D1", noop);
  const stats = gate.stats();
  ok(stats.totalDrives === 3, "every drive is counted once");
  ok(stats.drivesPerChannel.get("slack/C1") === 2 && stats.drivesPerChannel.get("discord/D1") === 1, "wakes are counted PER CHANNEL, which is the number a live run had no record of");

  const line = renderPacingLine(stats, { floorMs: 10_000, maxConcurrentPerSurface: 2 });
  ok(line.startsWith("pacing:"), "the report line is tagged `pacing:` so a shipper can find it in a 40-minute log");
  ok(line.includes("slack/C1=2") && line.includes("discord/D1=1"), "the line carries wakes per channel");
  ok(line.includes("max concurrency observed"), "…and the observed concurrency, which is the other half OPE-1882 asks for");
  ok(line.includes("slack/C1=2, discord/D1=1"), "channels are ordered busiest first — the crowded one is what a reader is looking for");

  const empty = renderPacingLine(createPacingGate().stats());
  ok(empty.includes("no drives this run"), "🔴 a run that drove nothing SAYS so rather than rendering an empty table, which would read as 'pacing is off'");
}

{
  ok(PACING_CHANNEL_FLOOR_MS > 0, "the shipped floor is a real floor — a zero default would make the gate a no-op nobody noticed");
  ok(PACING_MAX_CONCURRENT_PER_SURFACE >= 1, "the shipped cap admits at least one drive, or the pack would deadlock on its first post");
  ok(
    renderPacingLine(createPacingGate().stats()).includes(String(PACING_CHANNEL_FLOOR_MS)),
    "the report line prints the floor ACTUALLY in force, so the numbers in a ship report are the numbers that ran",
  );
}

{
  const classes: Record<string, new (...args: never[]) => object> = {
    SlackDriver,
    DiscordDriver,
    TeamsDriver,
    GithubDriver,
    LinearDriver,
    NotionDriver,
  };
  for (const forge of ["SyntheticSlack", "WebhookDriver", "PrApi"]) {
    ok(PACED_DRIVER_METHODS[forge] !== undefined, `${forge} has an entry, so a reader can see the forge drivers were considered`);
    ok(PACED_DRIVER_METHODS[forge]?.length === 0, `🔴 ${forge} stays UNPACED — a method appearing here would be an unreviewed change to what the gate covers`);
  }
  for (const [name, ctor] of Object.entries(classes)) {
    const listed = PACED_DRIVER_METHODS[name];
    ok(listed !== undefined, `${name} has an entry in PACED_DRIVER_METHODS — an unlisted driver class is one the gate never wraps`);
    const proto = ctor.prototype as object;
    const own = Object.getOwnPropertyNames(proto).filter((p) => {
      const d = Object.getOwnPropertyDescriptor(proto, p);
      return p !== "constructor" && typeof d?.value === "function";
    });
    for (const method of listed!) {
      ok(own.includes(method), `${name}.${method} still exists — a renamed method would leave the gate pacing nothing, with no error`);
    }
    for (const method of own.filter((m) => m.startsWith("post"))) {
      ok(listed!.includes(method), `🔴 ${name}.${method} drives a post and MUST be listed in PACED_DRIVER_METHODS — an unpaced drive is the crowding this gate exists to stop`);
    }
  }

  const offPattern: readonly [string, string, string][] = [
    ["SlackDriver", "uploadImage", "F-ART uploads a file whose initialComment MENTIONS the agent, into the same channel as the anchor post two lines above it"],
    ["SlackDriver", "update", "the edit leg overwrites a message at the same ts, and the agent wakes with an edit reason"],
    ["LinearDriver", "assign", "the assign-wake leg: assigning a fresh issue to the agent opens an agent session"],
  ];
  for (const [cls, method, why] of offPattern) {
    ok(PACED_DRIVER_METHODS[cls]?.includes(method) === true, `🔴 ${cls}.${method} stays paced — ${why}`);
  }
}

{
  const gate = createPacingGate({ floorMs: 0, maxConcurrentPerSurface: 4, clock: fakeClock() });
  class Fake {
    constructor(readonly channelId: string) {}
    async post(text: string): Promise<string> {
      return `${this.channelId}:${text}`;
    }
    withChannel(channel: string): Fake {
      return new Fake(channel);
    }
    mention(text: string): string {
      return `@oe ${text}`;
    }
  }
  const untouched = new Fake("C1");
  ok(paceDriver(untouched, "slack", gate) === untouched, "a class the table does not name comes back unwrapped, so an unpaced driver costs nothing");

  Object.defineProperty(Fake, "name", { value: "SlackDriver" });
  const paced = paceDriver(new Fake("C1"), "slack", gate) as Fake;
  ok((await paced.post("hi")) === "C1:hi", "🔴 a paced call returns the driver's own result unchanged — the gate delays, it never rewrites");
  ok(paced.mention("hi") === "@oe hi", "an unpaced method still works and is not counted");
  ok(gate.stats().totalDrives === 1, "…and only the paced call was counted");

  const rebound = paced.withChannel("C2");
  ok((await rebound.post("yo")) === "C2:yo", "a rebound driver still posts correctly");
  ok(gate.stats().drivesPerChannel.get("slack/C2") === 1, "🔴 `withChannel` RE-WRAPS: a rebound driver stays paced, and its drives are attributed to the NEW room");

  ok(paceMaybe(undefined, "slack", gate) === undefined, "an absent driver stays absent — every runner wiring line keeps its `.ok` shape");
}

console.log(`✓ e2e pacing gate: ${n} assertions`);
