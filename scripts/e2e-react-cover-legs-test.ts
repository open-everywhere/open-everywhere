import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV, resolveCapabilities, resolveTeamsSecondary } from "../packages/core/scripts/e2e/env.js";
import { FixtureMissing, GateFailure, SCENARIOS, type ScenarioContext } from "../packages/core/scripts/e2e/scenarios.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const leg = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  assert.ok(s, `${id} is in the pack`);
  return s!;
};

let seq = 0;
const row = (action: string, fields: Partial<AuditWireEntry> & { detail?: Record<string, unknown> }): AuditWireEntry =>
  ({ seq: ++seq, ts: new Date().toISOString(), org: "default", platform: "slack", workspace: "T1", action, ...fields }) as AuditWireEntry;

const markRow = (): AuditWireEntry => row("control.service_call", {});

type Outcome = "PASS" | `RED: ${string}` | `FIXTURE: ${string}` | `CRASH: ${string}`;

async function drive(id: string, parts: Partial<ScenarioContext>, rows: AuditWireEntry[]): Promise<Outcome> {
  const ctx = {
    auditRead: async (opts: { readonly actions?: readonly string[]; readonly platform?: string }) =>
      opts.actions?.includes("control.service_call")
        ? [markRow()]
        : rows.filter((r) => (opts.actions === undefined || opts.actions.includes(r.action)) && (opts.platform === undefined || r.platform === opts.platform)),
    gate: (cond: boolean, label: string) => {
      if (!cond) throw new GateFailure(label);
    },
    fixtureMissing: (reason: string): never => {
      throw new FixtureMissing(reason);
    },
    log: () => undefined,
    observe: () => undefined,
    ...parts,
  } as unknown as ScenarioContext;
  try {
    await leg(id).run(ctx);
    return "PASS";
  } catch (err) {
    if (err instanceof GateFailure) return `RED: ${err.message}`;
    if (err instanceof FixtureMissing) return `FIXTURE: ${err.message}`;
    return `CRASH: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface ReactFake {
  readonly probe?: { ok: boolean; error?: string; needed?: string };
  readonly onAdd?: (replyTs: string) => AuditWireEntry[];
  readonly onRemove?: (replyTs: string) => AuditWireEntry[];
  readonly onAnchor?: (anchorTs: string) => AuditWireEntry[];
}

const feedback0 = (verb: string, ts: string) =>
  row("reaction.feedback", { principalId: "UDRIVER", detail: { surface: "slack", verb, emoji: "thumbsup", emojiClass: "positive", channelId: "CBASE", messageId: ts, onBotReply: true } });

async function driveReact(fake: ReactFake, extra: Partial<ScenarioContext> = {}): Promise<{ outcome: Outcome; reactions: Set<string> }> {
  const rows: AuditWireEntry[] = [];
  const reactions = new Set<string>();
  const ANCHOR = "1700.0001";
  const REPLY = "1700.0002";
  const feedback = (verb: string, ts: string, principalId = "UDRIVER") =>
    row("reaction.feedback", { principalId, detail: { surface: "slack", verb, emoji: "thumbsup", emojiClass: "positive", channelId: "CBASE", messageId: ts, onBotReply: true } });
  const slack = {
    channelId: "CBASE",
    identity: async () => ({ userId: "UDRIVER", teamId: "T1" }),
    mention: (t: string) => `<@UBOT> ${t}`,
    post: async () => ({ ts: ANCHOR }),
    awaitThreadReply: async () => ({ ts: REPLY, text: "ready", userId: "UBOT" }),
    isBotMessage: (m: { userId?: string }) => m.userId === "UBOT",
    react: async (verb: "add" | "remove", ts: string) => {
      if (ts === ANCHOR && verb === "add") {
        const answer = fake.probe ?? { ok: true };
        if (answer.ok) {
          reactions.add(ts);
          rows.push(...(fake.onAnchor?.(ts) ?? []));
        }
        return answer;
      }
      if (verb === "add") {
        reactions.add(ts);
        rows.push(...(fake.onAdd?.(ts) ?? [feedback("added", ts)]));
      } else {
        reactions.delete(ts);
        if (ts === REPLY) rows.push(feedback("removed", ts), ...(fake.onRemove?.(ts) ?? []));
      }
      return { ok: true };
    },
  };
  const outcome = await drive("J-REACT-slack", { slack: slack as unknown as ScenarioContext["slack"], ...extra }, rows);
  return { outcome, reactions };
}

{
  const green = await driveReact({});
  ok(green.outcome === "PASS", `J-REACT-slack: a correct deployment passes (got ${green.outcome})`);
  ok(green.reactions.size === 0, "J-REACT-slack: the leg removes both of its reactions");

  const noScope = await driveReact({ probe: { ok: false, error: "missing_scope", needed: "reactions:write" } });
  ok(noScope.outcome.startsWith("FIXTURE:") && noScope.outcome.includes("reactions:write") && noScope.outcome.includes("E2E_SLACK_USER_TOKEN"), `J-REACT-slack: no reactions:write scope is a missing fixture that names the grant (got ${noScope.outcome})`);

  const controlRow = await driveReact({ onAnchor: (ts) => [row("reaction.feedback", { principalId: "UDRIVER", detail: { verb: "added", messageId: ts, emojiClass: "positive", channelId: "CBASE", onBotReply: true } })] });
  ok(controlRow.outcome.startsWith("RED:") && controlRow.outcome.includes("wrote NO"), `🔴 J-REACT-slack: a row for the member's own message reds the control (got ${controlRow.outcome})`);
  ok(controlRow.reactions.size === 0, "J-REACT-slack: …and the finally still removes the reactions");

  const cut = await driveReact({}, { auditWindowRead: async () => ({ entries: [], capped: true, scanTruncated: false }) } as Partial<ScenarioContext>);
  ok(cut.outcome.startsWith("RED:") && cut.outcome.includes("not cut"), `🔴 J-REACT-slack: a cut audit page reds the control instead of skipping it (got ${cut.outcome})`);

  const asBot = await driveReact({ onAdd: (ts) => [row("reaction.feedback", { principalId: "UBOT", detail: { verb: "added", messageId: ts, emojiClass: "positive", channelId: "CBASE", onBotReply: true } })] });
  ok(asBot.outcome.startsWith("RED:") && asBot.outcome.includes("names the person who reacted"), `J-REACT-slack: a row naming the agent reds (got ${asBot.outcome})`);

  const twice = await driveReact({
    onAdd: (ts) => [1, 2].map(() => row("reaction.feedback", { principalId: "UDRIVER", detail: { verb: "added", messageId: ts, emojiClass: "positive", channelId: "CBASE", onBotReply: true } })),
  });
  ok(twice.outcome.startsWith("RED:") && twice.outcome.includes("exactly ONE"), `J-REACT-slack: two rows for one 👍 red (got ${twice.outcome})`);

  const late = await driveReact({ onRemove: (ts) => [feedback0("added", ts)] });
  ok(late.outcome.startsWith("RED:") && late.outcome.includes("still exactly ONE"), `🔴 J-REACT-slack: a duplicate added row that lands after the first poll reds the final re-count (got ${late.outcome})`);

  const negative = await driveReact({ onAdd: (ts) => [row("reaction.feedback", { principalId: "UDRIVER", detail: { verb: "added", messageId: ts, emojiClass: "negative", channelId: "CBASE", onBotReply: true } })] });
  ok(negative.outcome.startsWith("RED:") && negative.outcome.includes("positive"), `J-REACT-slack: a 👍 bucketed anything but positive reds (got ${negative.outcome})`);
}

interface CoverFake {
  readonly onAnswer?: string;
  readonly onTimeout?: boolean;
  readonly noRecapMessage?: boolean;
  readonly askerId?: string;
  readonly replyText?: string;
  readonly recap?: Record<string, unknown>;
}

async function driveCover(fake: CoverFake): Promise<{ outcome: Outcome; dms: string[]; bounds: (string | undefined)[]; offAnsweredAt?: string }> {
  const rows: AuditWireEntry[] = [];
  const dms: string[] = [];
  const PERSON = "teams/29:driver";
  const tm = (action: string, detail: Record<string, unknown>) => row(action, { platform: "teams", principalId: PERSON, detail });
  let clock = Date.parse("2026-10-20T00:00:00.000Z");
  const at = () => new Date((clock += 1_000)).toISOString();
  const chat: { text: string; bot: boolean; createdDateTime: string }[] = [];
  const bounds: (string | undefined)[] = [];
  const teams = {
    resolveDmChat: async () => ({ chatId: "19:dm" }),
    postDm: async (_chat: string, text: string) => {
      dms.push(text);
      const sent = { text, bot: false, createdDateTime: at() };
      chat.push(sent);
      if (text === "oe cover on") {
        if ((fake.onAnswer ?? "Done.").startsWith("Done.")) rows.push(tm("cover.set", { on: true, via: "command" }));
        if (!fake.onTimeout) chat.push({ text: fake.onAnswer ?? "Done. Cover is on. When someone mentions you…", bot: true, createdDateTime: at() });
      }
      if (text === "oe cover off") {
        rows.push(tm("cover.set", { on: false, via: "command" }));
        chat.push({ text: "Cover is off. I'll send you a recap of the 1 question I covered in your DM within a few minutes.", bot: true, createdDateTime: at() });
        rows.push(tm("cover.recap", fake.recap ?? { questions: 1, leftOut: 0, sent: true }));
        if (!fake.noRecapMessage) chat.push({ text: "While you were away, one person asked about the e2e cover check.", bot: true, createdDateTime: at() });
      }
      return { id: `dm${dms.length}`, fromUserId: "aad-driver", text, createdDateTime: sent.createdDateTime };
    },
    awaitDmReply: async (_chat: string, opts: { afterIso?: string }) => {
      bounds.push(opts.afterIso);
      const m = chat.find((x) => x.bot && (opts.afterIso === undefined || x.createdDateTime > opts.afterIso));
      if (!m) throw new Error("timed out waiting for a bot reply in the 1:1 chat");
      return { id: m.createdDateTime, text: m.text, createdDateTime: m.createdDateTime };
    },
    displayName: async () => "Driver",
    awaitReply: async () => ({ id: "r1", text: fake.replyText ?? "Cover for Driver, who is away: yes, it is scheduled." }),
  };
  const asker = {
    postMentionWithPerson: async (person: { id: string }) => {
      ok(person.id === "aad-driver", "S-COVER-teams: the asker @mentions the driver by the Entra id Graph returned on the driver's own post");
      rows.push(tm("cover.wake", { wakeId: "w1", recorded: true, mentioned: 1 }));
      rows.push(tm("cover.answered", { wakeId: "w1", chars: 40 }));
      return { id: "root1", fromUserId: fake.askerId ?? "aad-asker", text: "q" };
    },
  };
  const outcome = await drive(
    "S-COVER-teams",
    { teams: teams as unknown as ScenarioContext["teams"], teamsSecondary: asker as unknown as ScenarioContext["teamsSecondary"] },
    rows,
  );
  const offAnswer = chat.find((x) => x.bot && x.text.startsWith("Cover is off."));
  return { outcome, dms, bounds, ...(offAnswer ? { offAnsweredAt: offAnswer.createdDateTime } : {}) };
}

{
  const green = await driveCover({});
  ok(green.outcome === "PASS", `S-COVER-teams: a correct deployment passes (got ${green.outcome})`);
  ok(green.dms.join("|") === "oe cover on|oe cover off", `S-COVER-teams: the leg turns cover on and off once each (got ${green.dms.join("|")})`);
  ok(green.bounds.at(-1) === green.offAnsweredAt && green.offAnsweredAt !== undefined, `🔴 S-COVER-teams: the recap wait is bounded on the off ANSWER's own time, so it can never return the off answer (got ${String(green.bounds.at(-1))})`);

  const refused = await driveCover({ onAnswer: "Cover is for members of this organisation, so I changed nothing." });
  ok(refused.outcome.startsWith("FIXTURE:") && refused.outcome.includes("did not bind"), `S-COVER-teams: a DM that does not bind as a member is a missing fixture (got ${refused.outcome})`);

  const self = await driveCover({ askerId: "aad-driver" });
  ok(self.outcome.startsWith("FIXTURE:") && self.outcome.includes(ENV.teamsSecondaryRefreshToken), `S-COVER-teams: a second token that signs in as the driver is a missing fixture naming the variable (got ${self.outcome})`);
  ok(self.dms.at(-1) === "oe cover off", "S-COVER-teams: …and the finally turns cover off");

  const unlabelled = await driveCover({ replyText: "Yes, it is scheduled." });
  ok(unlabelled.outcome.startsWith("RED:") && unlabelled.outcome.includes("cover label"), `S-COVER-teams: a reply with no cover label reds (got ${unlabelled.outcome})`);
  ok(unlabelled.dms.at(-1) === "oe cover off", "🔴 S-COVER-teams: a red gate still turns cover off in the finally");

  const lostAnswer = await driveCover({ onTimeout: true });
  ok(lostAnswer.outcome.startsWith("CRASH:") && lostAnswer.dms.join("|") === "oe cover on|oe cover off", `🔴 S-COVER-teams: an \`on\` whose answer never came still turns cover off (got ${lostAnswer.outcome}, ${lostAnswer.dms.join("|")})`);

  const noRecap = await driveCover({ noRecapMessage: true });
  ok(noRecap.outcome.startsWith("CRASH:") && noRecap.outcome.includes("1:1 chat"), `S-COVER-teams: a recap row with no recap message in the chat fails the leg (got ${noRecap.outcome})`);

  const rosterRefused = await driveCover({ recap: { questions: 0, leftOut: 1, sent: false } });
  ok(rosterRefused.outcome.startsWith("RED:") && rosterRefused.outcome.includes("roster"), `🔴 S-COVER-teams: a recap that left the question out (the roster read refused) reds (got ${rosterRefused.outcome})`);
}

{
  const app = mkdtempSync(join(tmpdir(), "oe-teams-secondary-"));
  writeFileSync(join(app, "package.json"), "{}\n");
  mkdirSync(join(app, "agent"));
  writeFileSync(join(app, "agent", "agent.ts"), "export {};\n");
  const base = { OE_APP_ROOT: app };
  const missing = resolveTeamsSecondary(base, app);
  ok(!missing.ok && missing.missing.join(",") === ENV.teamsSecondaryRefreshToken, `resolveTeamsSecondary names its one variable (got ${JSON.stringify(missing)})`);
  const set = resolveTeamsSecondary({ ...base, [ENV.teamsSecondaryRefreshToken]: "rt-2" }, app);
  ok(set.ok && set.cfg.refreshToken === "rt-2" && set.cfg.refreshTokenFile === join(app, ".env.e2e.teams-secondary-refresh"), `the second user gets its own sidecar at the app root (got ${JSON.stringify(set)})`);
  const shared = resolveTeamsSecondary({ ...base, [ENV.teamsSecondaryRefreshToken]: "rt-2", [ENV.teamsSecondaryRefreshTokenFile]: ".env.e2e.teams-refresh" }, app);
  ok(!shared.ok && shared.missing[0]!.includes("base sidecar"), `🔴 a sidecar shared with the base driver is refused (got ${JSON.stringify(shared)})`);
  const caps = resolveCapabilities({ ...base, [ENV.teamsSecondaryRefreshToken]: "rt-2" });
  ok(caps.available.has("teamsSecondary") && !caps.available.has("teams"), "the capability report carries teamsSecondary on its own variable, and S-COVER-teams still needs the base teams capability beside it");
  ok(leg("S-COVER-teams").requires.join(",") === "teams,teamsSecondary", "S-COVER-teams requires the base Teams driver AND the second user");
}

console.log(`✓ e2e react + cover legs: ${n} assertions`);
