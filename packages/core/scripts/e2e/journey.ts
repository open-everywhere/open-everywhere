import type { SlackDriver, SlackMessage, SlackMessageAction } from "./slack-driver.js";
import type { SyntheticSlack } from "./synthetic.js";
import { APPROVAL_PREFIX } from "./synthetic.js";
import { pollOptional, pollUntil } from "./poll.js";
import { slackVendorEventTime } from "../../agent/channels/wake-timing.js";
import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";

export function factToken(stem: string): string {
  return `${stem}-${Date.now() % 100_000}`;
}

function factTokenDigits(token: string): string | undefined {
  return /-(\d{1,5})$/.exec(token)?.[1];
}

export function supervisorAsk(marker: string): { readonly text: string; readonly sum: number } {
  const n = Number(factTokenDigits(marker) ?? "0");
  const a = 11 + (n % 83);
  const b = 11 + (Math.floor(n / 83) % 83);
  return {
    text: `Quick question for whoever's around — what's ${a} plus ${b}? Please include the ref ${marker} in your reply so I can find it.`,
    sum: a + b,
  };
}

export function distinctFactToken(stem: string, taken: readonly string[], seed: number = Date.now() % 100_000): string {
  const used = new Set(taken.map(factTokenDigits).filter((d): d is string => d !== undefined));
  let n = ((Math.trunc(seed) % 100_000) + 100_000) % 100_000;
  for (let i = 0; i < 100_000 && used.has(String(n)); i++) n = (n + 1) % 100_000;
  return `${stem}-${n}`;
}

export function carriesFactToken(text: string, token: string): boolean {
  if (text.includes(token)) return true;
  const digits = factTokenDigits(token);
  if (digits === undefined) return false;
  const stem = token.slice(0, token.length - digits.length - 1);
  const prefix = stem.slice(0, 3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (prefix.length === 0) return false;
  return new RegExp(`(?:^|[^a-z0-9])${prefix}[a-z0-9]{0,12}-?(?<!\\d)${digits}(?!\\d)`, "i").test(text);
}

export function examinedPostLines(posts: readonly SlackMessage[], limit = 12): readonly string[] {
  const ordered = [...posts].sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  const tail = limit <= 0 ? [] : ordered.slice(-limit);
  const lines = tail.map((m) => `${m.ts} | ${m.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  const elided = posts.length - tail.length;
  return elided > 0 ? [`… ${elided} earlier bot post(s) elided`, ...lines] : lines;
}

export function bareSurfaceSegment(value: string): string {
  const last = value.split("/").pop();
  return last === undefined || last.length === 0 ? value : last;
}

export function otherFactTokens(text: string, stem: string, mine: string): readonly string[] {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = text.match(new RegExp(`${escaped}-\\d{1,5}`, "gi")) ?? [];
  const seen: string[] = [];
  for (const raw of found) {
    const t = raw.toLowerCase();
    if (t === mine.toLowerCase()) continue;
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

export function withoutMarker(text: string, marker: string): string {
  return marker.length === 0 ? text : text.split(marker).join(" ");
}

export function approveButton(m: SlackMessage): { pendingId: string; org: string } | undefined {
  const prefix = `${APPROVAL_PREFIX}approve:`;
  const btn = m.actions?.find((a) => a.actionId.startsWith(prefix));
  if (!btn) return undefined;
  return { pendingId: btn.actionId.slice(prefix.length), org: btn.value ?? "" };
}

export function contradictButton(m: SlackMessage): { pendingId: string; org: string } | undefined {
  const prefix = `${APPROVAL_PREFIX}contradict:`;
  const btn = m.actions?.find((a) => a.actionId.startsWith(prefix));
  if (!btn) return undefined;
  return { pendingId: btn.actionId.slice(prefix.length), org: btn.value ?? "" };
}

const EVE_APPROVE_LABEL = /^(approve|allow)$/i;
const EVE_DENY_LABEL = /^(reject|deny|cancel)$/i;
const EVE_APPROVE_VALUES: ReadonlySet<string> = new Set(["approve"]);
const EVE_DENY_VALUES: ReadonlySet<string> = new Set(["cancel", "reject"]);

export function eveRequestApprovalButtons(
  m: SlackMessage,
): { readonly approve: SlackMessageAction; readonly deny?: SlackMessageAction } | undefined {
  const buttons = (m.actions ?? []).filter((a) => !a.actionId.startsWith(APPROVAL_PREFIX));
  const approve = buttons.find((a) => EVE_APPROVE_VALUES.has(a.value ?? "") || EVE_APPROVE_LABEL.test((a.text ?? "").trim()));
  if (!approve) return undefined;
  const deny = buttons.find((a) => a !== approve && (EVE_DENY_VALUES.has(a.value ?? "") || EVE_DENY_LABEL.test((a.text ?? "").trim())));
  return deny ? { approve, deny } : { approve };
}

export type GateFn = (cond: boolean, label: string) => void;

export function legGate(gate: GateFn, leg: string): GateFn {
  return (cond, label) => gate(cond, `${leg}: ${label}`);
}

export async function postAwait(
  slack: SlackDriver,
  ask: string,
  opts: { timeoutMs: number },
): Promise<{ rootTs: string; reply: SlackMessage }> {
  const { ts: rootTs } = await slack.post(slack.mention(ask));
  const reply = await slack.awaitThreadReply(rootTs, { timeoutMs: opts.timeoutMs });
  return { rootTs, reply };
}

export async function collectSilence(
  slack: SlackDriver,
  rootTs: string,
  afterTs: string,
  windowMs: number,
): Promise<readonly SlackMessage[]> {
  return slack.collectRepliesDuring(rootTs, afterTs, windowMs);
}

export async function awaitCard(slack: SlackDriver, threadTs: string, timeoutMs: number): Promise<SlackMessage> {
  return slack.awaitThreadMessage(
    threadTs,
    { timeoutMs, what: `an approval card (oe_approval buttons) in thread ${threadTs}` },
    (msgs) => msgs.find((m) => slack.isBotReply(m) && approveButton(m) !== undefined),
  );
}

export async function awaitDecided(slack: SlackDriver, threadTs: string, cardTs: string, timeoutMs: number): Promise<SlackMessage> {
  return slack.awaitThreadMessage(
    threadTs,
    { timeoutMs, what: `card ${cardTs} re-rendered decided (actions block gone)` },
    (msgs) => msgs.find((m) => m.ts === cardTs && approveButton(m) === undefined),
  );
}

export async function driveDecide(args: {
  slack: SlackDriver;
  synthetic: SyntheticSlack;
  gate: GateFn;
  log: (line: string) => void;
  ask: string;
  leg: string;
  decision?: "approve" | "reject";
  timeoutMs: number;
  precheck?: (card: SlackMessage) => string | undefined;
}): Promise<SlackMessage> {
  const { slack, synthetic, ask, leg, timeoutMs } = args;
  const gate = legGate(args.gate, leg);
  const decision = args.decision ?? "approve";
  const { ts: askTs } = await slack.post(slack.mention(ask));
  const card = await awaitCard(slack, askTs, timeoutMs);
  const btn = approveButton(card)!;
  gate(btn.pendingId.length > 0, "card button carries a real pending id in its action_id");
  gate(btn.org.length > 0, "card button carries the org in its value (flow.ts needs it pre-lookup)");
  const { teamId } = await slack.identity();
  const fault = args.precheck?.(card);
  if (fault !== undefined) {
    const refused = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision: "reject", messageTs: card.ts, channelId: slack.channelId, teamId });
    args.log(`${refused.label}: precheck fault, reject ${btn.pendingId} (org "${btn.org}") → ${refused.status}`);
    await awaitDecided(slack, askTs, card.ts, timeoutMs).catch(() => undefined);
    gate(false, `card precheck: ${fault}`);
  }
  const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision, messageTs: card.ts, channelId: slack.channelId, teamId });
  args.log(`${clicked.label}: ${decision} ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
  gate(clicked.status === 200, `forged ${decision} click acked 200`);
  await awaitDecided(slack, askTs, card.ts, timeoutMs);
  args.log(`card DECIDED — buttons removed by the deployment's chat.update`);
  return card;
}

interface SpendGateDetail {
  readonly door?: unknown;
  readonly key?: unknown;
  readonly mode?: unknown;
  readonly reason?: unknown;
  readonly over?: unknown;
}

export function describeSpendGateRows(rows: readonly AuditWireEntry[]): string | undefined {
  const gates = rows.filter((r) => r.action === "spend.gate");
  if (gates.length === 0) return undefined;
  const first = gates[0]!;
  const d = (first.detail ?? {}) as SpendGateDetail;
  const parts = [
    `${gates.length} spend.gate row(s) in the run window`,
    `door=${typeof d.door === "string" ? d.door : "(none)"}`,
    `key=${typeof d.key === "string" ? d.key : "(none)"}`,
    ...(typeof d.mode === "string" ? [`mode=${d.mode}`] : []),
    `platform=${first.platform}`,
    ...(typeof d.reason === "string" ? [`reason="${d.reason}"`] : []),
  ];
  return parts.join(" ");
}

export function spendGateDoorOf(rows: readonly AuditWireEntry[]): string | undefined {
  const first = rows.find((r) => r.action === "spend.gate");
  const door = (first?.detail as SpendGateDetail | undefined)?.door;
  return typeof door === "string" && door.length > 0 ? door : undefined;
}

export const SPEND_GATE_DOORS = ["mention", "engagement", "join", "window"] as const;

export const DECLARED_SILENCE_ROW_WAIT_MS = 30_000;

export interface SilenceAssertionPlan {
  readonly always: readonly string[];
  readonly whenDeclared: readonly string[];
  readonly alwaysLabel: string;
  readonly declaredLabel: string;
}

export function silenceAssertionPlan(surfaceAction: string, silencesDeclared: boolean): SilenceAssertionPlan {
  return {
    always: ["reply.no_reply_observed"],
    whenDeclared: silencesDeclared ? [surfaceAction, "unified.no_reply"] : [],
    alwaysLabel:
      "audited silence: a reply.no_reply_observed row exists for the run (the ALWAYS-ON judged-silence row — the positive assertion that holds on prod's actions-only posture). " +
      "Absent, either a silent turn left NO trace at all, or no turn ran — read the silence-WINDOW gate and the classifySilence line beside this one to tell those apart",
    declaredLabel: `audited silence (declared silence-audit switch): a ${surfaceAction}/unified.no_reply row exists for the run (the FULL-DETAIL judged-silence row this target declares it writes)`,
  };
}

export type SilenceCause = { readonly kind: "unwired" } | { readonly kind: "routing" } | { readonly kind: "cap"; readonly detail: string };

export async function classifySilence(
  auditRead: ((opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>) | undefined,
  sinceIso: string,
  opts: { readonly platform?: string } = {},
): Promise<SilenceCause> {
  if (!auditRead) return { kind: "unwired" };
  try {
    const rows = await auditRead({ sinceIso, actions: ["spend.gate"], ...(opts.platform ? { platform: opts.platform } : {}) });
    const detail = describeSpendGateRows(rows);
    return detail === undefined ? { kind: "routing" } : { kind: "cap", detail };
  } catch {
    return { kind: "unwired" };
  }
}

export async function assertAuditedSilence(args: {
  readonly auditRead: (opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>;
  readonly sinceIso: string;
  readonly surfaceAction: string;
  readonly silencesDeclared: boolean;
  readonly timeoutMs: number;
  readonly gate: (ok: boolean, label: string) => void;
  readonly log: (msg: string) => void;
}): Promise<void> {
  const plan = silenceAssertionPlan(args.surfaceAction, args.silencesDeclared);
  const seen = await pollOptional(
    async () => {
      const r = await args.auditRead({ sinceIso: args.sinceIso, actions: [...plan.always] });
      return r.length > 0 ? r : undefined;
    },
    { timeoutMs: args.timeoutMs, what: plan.alwaysLabel },
  );
  args.gate((seen ?? []).length > 0, plan.alwaysLabel);
  if (plan.whenDeclared.length === 0) {
    args.log("silence auditing not declared for this target — asserting the ALWAYS-ON reply.no_reply_observed row only; set E2E_AUDIT_SILENCES=1 against a local eval target that arms the silence-audit test switch to assert the full-detail row too");
    return;
  }
  const declared = await pollOptional(
    async () => {
      const r = await args.auditRead({ sinceIso: args.sinceIso, actions: [...plan.whenDeclared] });
      return r.length > 0 ? r : undefined;
    },
    { timeoutMs: Math.min(args.timeoutMs, DECLARED_SILENCE_ROW_WAIT_MS), what: plan.declaredLabel },
  );
  args.gate((declared ?? []).length > 0, plan.declaredLabel);
}

export function silenceCauseGate(cause: SilenceCause): { readonly ok: boolean; readonly label: string } {
  if (cause.kind === "cap") {
    return {
      ok: false,
      label:
        `the silence is a CAP REFUSAL, not routing — ${cause.detail}. While this scope is over cap EVERY wake here is ` +
        `dropped before a model turn, so the silence leg proves nothing about the mention/ambient gate. Raise or clear ` +
        `the cap on this fixture's scope and re-run.`,
    };
  }
  if (cause.kind === "unwired") {
    return {
      ok: true,
      label:
        "silence cause not discriminated — no audit read wired (set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN to tell a " +
        "routing silence from a spend-cap refusal; since 6687d86f a capped surface goes silent for a money reason)",
    };
  }
  return { ok: true, label: "the silence is a routing decision, not a spend-cap refusal (no spend.gate row in the run window)" };
}

export const LINK_CODE_ALPHABET = "23456789ACDEFGHJKLMNPQRSTUVWXYZ";

export function parseLinkCode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const anchored = new RegExp(`\\blink${LINK_CODE_PUNCT}+(${LINK_CODE_CLASS}{8})\\b`, "i").exec(text);
  if (anchored) return anchored[1]!.toUpperCase();
  return bareCodeLine(text);
}

const LINK_CODE_CLASS = `[${LINK_CODE_ALPHABET}]`;
const LINK_CODE_PUNCT = "[\\s:*_`\\-]";

function bareCodeLine(text: string): string | undefined {
  const re = new RegExp(`^${LINK_CODE_PUNCT}*(${LINK_CODE_CLASS}{8})${LINK_CODE_PUNCT}*$`);
  for (const line of text.split("\n")) {
    const bare = re.exec(line);
    if (bare) return bare[1]!;
  }
  return undefined;
}

export const CLAIM_CODE_BACK_MARKER = /enter this code where they started it/i;

export function parseClaimCodeBack(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const marker = CLAIM_CODE_BACK_MARKER.exec(text);
  if (!marker) return undefined;
  return bareCodeLine(text.slice(marker.index + marker[0].length));
}

export interface PrReadback {
  getPr(prNumber: number): Promise<{ readonly head: string; readonly base: string } | undefined>;
  prContainsToken(prNumber: number, token: string): Promise<boolean>;
}

export function classifyPrMiss(replyText: string): "grant-refused" | "errored" | "no-tool" {
  if (/not granted to this channel|grant it via a bundle|not in the granted/i.test(replyText)) return "grant-refused";
  if (/(push|staging|commit|checkout|clone|git)[^.]{0,48}(fail|error)|could ?n.?t (?:push|open|create|stage|commit|clone|check ?out)/i.test(replyText))
    return "errored";
  return "no-tool";
}

export interface JudgeAllowEvidence {
  readonly tool: string;
  readonly action?: string;
  readonly verdict?: string;
  readonly enforcedVerdict: "allow";
  readonly resolvedBy?: string;
  readonly source?: string;
  readonly passes?: number;
  readonly reasoning?: string;
}

export function findJudgeAllow(rows: readonly AuditWireEntry[], tool: string): JudgeAllowEvidence | undefined {
  for (const row of rows) {
    if (row.action !== "approval.judge.verdict") continue;
    const d = row.detail as Record<string, unknown> | undefined;
    if (d?.tool !== tool || d?.enforcedVerdict !== "allow") continue;
    return {
      tool,
      enforcedVerdict: "allow",
      ...(typeof d.action === "string" ? { action: d.action } : {}),
      ...(typeof d.verdict === "string" ? { verdict: d.verdict } : {}),
      ...(typeof d.resolvedBy === "string" ? { resolvedBy: d.resolvedBy } : {}),
      ...(typeof d.source === "string" ? { source: d.source } : {}),
      ...(typeof d.passes === "number" ? { passes: d.passes } : {}),
      ...(typeof d.reasoning === "string" ? { reasoning: d.reasoning } : {}),
    };
  }
  return undefined;
}

export interface PrOpenPublish {
  readonly number: number;
  readonly head?: string;
}

export function prOpenRowPublishes(rows: readonly AuditWireEntry[], repo?: string): readonly PrOpenPublish[] {
  const out: PrOpenPublish[] = [];
  for (const row of rows) {
    if (row.action !== "pr.open") continue;
    const d = row.detail as Record<string, unknown> | undefined;
    if (repo !== undefined && d?.repo !== repo) continue;
    const n = d?.number;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
    if (out.some((p) => p.number === n)) continue;
    const head = d?.head;
    out.push(typeof head === "string" && head.length > 0 ? { number: n, head } : { number: n });
  }
  return out;
}

export type PrDriveResult =
  | { readonly published: true; readonly arm: "card"; readonly card: SlackMessage; readonly prNumber: number; readonly head: string; readonly askTs: string }
  | { readonly published: true; readonly arm: "judge-allow"; readonly card?: undefined; readonly judge: JudgeAllowEvidence; readonly prNumber: number; readonly head: string; readonly askTs: string }
  | { readonly published: false; readonly miss: PrDriveMiss; readonly reason: string };

export type PrDriveMiss = "grant-refused" | "errored" | "no-tool" | "published-unevidenced";

export async function firstOfTwo<A, B>(
  a: Promise<A | undefined>,
  b: Promise<B | undefined>,
): Promise<{ readonly which: "a"; readonly value: A } | { readonly which: "b"; readonly value: B } | undefined> {
  const never = new Promise<never>(() => {});
  return Promise.race([
    a.then((value) => (value === undefined ? never : ({ which: "a", value }) as const)),
    b.then((value) => (value === undefined ? never : ({ which: "b", value }) as const)),
    Promise.all([a, b]).then(() => undefined),
  ]);
}

export async function drivePrOpen(args: {
  slack: SlackDriver;
  synthetic: SyntheticSlack;
  gate: GateFn;
  log: (line: string) => void;
  pr: PrReadback;
  ask: string;
  token: string;
  base: string;
  leg: string;
  timeoutMs: number;
  beforeApprove?: (card: SlackMessage) => void | Promise<void>;
  decision?: "approve" | "approve_session";
  onPublished?: (pr: { readonly number: number; readonly head: string }) => void;
  auditRead?: (opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>;
  repo?: string;
}): Promise<PrDriveResult> {
  const { slack, synthetic, pr, ask, token, base, timeoutMs } = args;
  const decision = args.decision ?? "approve";
  const gate = legGate(args.gate, args.leg);
  const { ts: askTs } = await slack.post(slack.mention(ask));
  const askIso = new Date((slackVendorEventTime(askTs)?.ms ?? Date.now()) - 5_000).toISOString();
  const firstReply = await slack.awaitThreadReply(askTs, { timeoutMs });

  let card: SlackMessage | undefined = approveButton(firstReply) !== undefined ? firstReply : undefined;

  const resolveJudgeArm = async (judge: JudgeAllowEvidence, prNumber: number): Promise<PrDriveResult> => {
    args.log(
      `ARM (b) JUDGE-ALLOW: no pr.open card — the chain resolved allow (judge said "${judge.verdict ?? "?"}", resolvedBy "${judge.resolvedBy ?? "?"}", source "${judge.source ?? "?"}", passes ${judge.passes ?? "?"}) and published PR #${prNumber} directly. Reasoning: ${(judge.reasoning ?? "(none recorded)").replace(/\s+/g, " ").slice(0, 400)}`,
    );
    const details = await pollUntil(async () => args.pr.getPr(prNumber), { timeoutMs, what: `the judge-published PR #${prNumber} readable via the GitHub API` });
    args.onPublished?.({ number: prNumber, head: details.head });
    gate(details.base === base, `the judge-published PR targets the "${base}" base branch (got "${details.base}")`);
    gate(
      await pr.prContainsToken(prNumber, token),
      `the judge-published PR's diff carries the run token "${token}" (the agent really made the change)`,
    );
    return { published: true, arm: "judge-allow", judge, prNumber, head: details.head, askTs };
  };

  const registerForTeardown = async (publish: PrOpenPublish): Promise<void> => {
    const head = publish.head ?? (await args.pr.getPr(publish.number).catch(() => undefined))?.head;
    if (head === undefined) {
      args.log(`teardown: PR #${publish.number} carries the run token "${token}" but neither its pr.open row nor the GitHub read names a head branch — CLOSE IT BY HAND`);
      return;
    }
    args.log(`teardown: PR #${publish.number} (head ${head}) carries the run token "${token}" although neither arm resolved — handed to the caller's teardown`);
    args.onPublished?.({ number: publish.number, head });
  };

  const readArmRows = async (
    auditRead: NonNullable<typeof args.auditRead>,
  ): Promise<{ judge?: JudgeAllowEvidence; publishes: readonly PrOpenPublish[] }> => {
    const rows = await auditRead({ sinceIso: askIso, actions: ["approval.judge.verdict", "pr.open"] });
    const judge = findJudgeAllow(rows, "open_pull_request");
    return { publishes: prOpenRowPublishes(rows, args.repo), ...(judge !== undefined ? { judge } : {}) };
  };

  const tokenCarrying = async (candidates: readonly PrOpenPublish[]): Promise<readonly PrOpenPublish[]> => {
    const mine: PrOpenPublish[] = [];
    for (const publish of candidates) {
      try {
        if (await pr.prContainsToken(publish.number, token)) mine.push(publish);
      } catch (err) {
        args.log(`teardown: could not read PR #${publish.number}'s diff to tell whether it carries the run token (${String(err instanceof Error ? err.message : err)}) — not claimed`);
      }
    }
    return mine;
  };

  let cardWaited = false;
  const auditRead = args.auditRead;
  if (card === undefined && auditRead !== undefined) {
    let seenJudge: JudgeAllowEvidence | undefined;
    let seenPublishes: readonly PrOpenPublish[] = [];
    const probe = pollOptional<{ judge: JudgeAllowEvidence; prNumber: number }>(
      async () => {
        const { judge, publishes } = await readArmRows(auditRead);
        if (publishes.length > 0) seenPublishes = publishes;
        if (judge === undefined) return undefined;
        seenJudge = judge;
        for (const publish of publishes) {
          if (await pr.prContainsToken(publish.number, token)) return { judge, prNumber: publish.number };
        }
        return undefined;
      },
      { timeoutMs, what: `an approval.judge.verdict allow + a token-carrying pr.open audit row for the card-less "${args.leg}" publish` },
    );
    const outcome = await firstOfTwo(probe, awaitCard(slack, askTs, timeoutMs).catch(() => undefined));
    cardWaited = true;
    if (outcome?.which === "b") card = outcome.value;
    const matched = outcome?.which === "a" ? outcome.value : undefined;
    const found = matched ?? (card === undefined && seenJudge !== undefined && seenPublishes.length > 0 ? { judge: seenJudge, prNumber: seenPublishes[0]!.number } : undefined);
    if (found !== undefined) return await resolveJudgeArm(found.judge, found.prNumber);
  } else if (card === undefined) {
    args.log(
      "no card in the first reply and NO audit read wired — arm (b) is off, so a judge-allow publish would read as a no-tool skip here. Set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN.",
    );
  }

  if (card === undefined && !cardWaited) card = await awaitCard(slack, askTs, timeoutMs).catch(() => undefined);
  if (!card) {
    if (auditRead !== undefined) {
      const late = await readArmRows(auditRead).catch((err) => {
        args.log(`final audit re-read before CANNOT RUN failed (${String(err instanceof Error ? err.message : err)}) — reporting the miss on the evidence already in hand`);
        return undefined;
      });
      if (late !== undefined) {
        const mine = await tokenCarrying(late.publishes);
        if (late.judge !== undefined && late.publishes.length > 0) {
          args.log("final audit re-read: an approval.judge.verdict allow landed after the probe's last tick — this run is arm (b), not a miss");
          return await resolveJudgeArm(late.judge, (mine[0] ?? late.publishes[0]!).number);
        }
        for (const publish of mine) await registerForTeardown(publish);
        if (mine.length > 0) {
          return {
            published: false,
            miss: "published-unevidenced",
            reason:
              `open_pull_request DID run: PR #${mine[0]!.number} is open and its diff carries this run's token "${token}", but NO approval.judge.verdict allow row ` +
              `and NO pr.open card was found for it, so neither arm could be evidenced. The PR was handed to the teardown. Reply: ${firstReply.text.replace(/\s+/g, " ").trim().slice(0, 240)}`,
          };
        }
      }
    }
    const reason = firstReply.text.replace(/\s+/g, " ").trim().slice(0, 240);
    return { published: false, miss: classifyPrMiss(firstReply.text), reason };
  }

  const btn = approveButton(card)!;
  gate(btn.pendingId.length > 0, "pr.open card carries a real pending id in its action_id");
  gate(btn.org.length > 0, "pr.open card carries the org in its value (flow.ts needs it pre-lookup)");
  await args.beforeApprove?.(card);

  const { teamId } = await slack.identity();
  const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision, messageTs: card.ts, channelId: slack.channelId, teamId });
  args.log(`${clicked.label}: ${decision} pr.open ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
  gate(clicked.status === 200, `forged admin ${decision} click acked 200`);
  const decided = await awaitDecided(slack, askTs, card.ts, timeoutMs);

  const urlMatch = decided.text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  gate(urlMatch !== null, `decided card names a published PR URL (execute succeeded) — got: "${decided.text.replace(/\s+/g, " ").trim().slice(0, 240)}"`);
  const prNumber = Number.parseInt(urlMatch![2], 10);
  args.log(`published PR ${urlMatch![1]}#${prNumber}`);

  const details = await pollUntil(async () => args.pr.getPr(prNumber), { timeoutMs, what: `the published PR #${prNumber} readable via the GitHub API` });
  args.onPublished?.({ number: prNumber, head: details.head });
  gate(details.base === base, `the published PR targets the "${base}" base branch (got "${details.base}")`);
  const hasToken = await pr.prContainsToken(prNumber, token);
  gate(hasToken, `the published PR's diff carries the run token "${token}" (the agent really made the change)`);
  return { published: true, arm: "card", card, prNumber, head: details.head, askTs };
}
