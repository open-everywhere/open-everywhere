import type { SlackDriver, SlackMessage, SlackMessageAction } from "./slack-driver.js";
import type { SyntheticSlack } from "./synthetic.js";
import { APPROVAL_PREFIX } from "./synthetic.js";
import { pollOptional, pollUntil } from "./poll.js";
import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";

export function factToken(stem: string): string {
  return `${stem}-${Date.now() % 100_000}`;
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

export const APPROVAL_REQUEST_PROVENANCE_ACTIONS = ["wake.ingress", "turn.question_bridged"] as const;

export function slackMessageTimestampIso(ts: string): string | undefined {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  const fraction = Number(`0.${match[2]}`);
  if (!Number.isFinite(seconds) || !Number.isFinite(fraction)) return undefined;
  const ms = Math.round(seconds * 1000 + fraction * 1000);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function approvalRequestForSlackAsk<T>(input: {
  readonly messages: readonly SlackMessage[];
  readonly auditRows: readonly AuditWireEntry[];
  readonly anchorTs: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly decode: (message: SlackMessage) => T | undefined;
}): { readonly message: SlackMessage; readonly decoded: T } | undefined {
  const anchorIso = slackMessageTimestampIso(input.anchorTs);
  if (anchorIso === undefined) return undefined;
  const surfaceKey = `slack/${input.teamId}/${input.channelId}`;

  const wakeIds = new Set<string>();
  for (const row of input.auditRows) {
    if (
      row.action !== APPROVAL_REQUEST_PROVENANCE_ACTIONS[0] ||
      row.platform !== "slack" ||
      row.detail?.surfaceKey !== surfaceKey ||
      row.detail.vendorTs !== anchorIso
    ) continue;
    const wakeId = row.detail.wakeId;
    if (typeof wakeId === "string" && wakeId.length > 0) wakeIds.add(wakeId);
  }
  if (wakeIds.size === 0) return undefined;

  const messageIds = new Set<string>();
  for (const row of input.auditRows) {
    if (
      row.action !== APPROVAL_REQUEST_PROVENANCE_ACTIONS[1] ||
      row.platform !== "unified" ||
      row.workspace !== input.teamId ||
      row.detail?.platform !== "slack" ||
      row.detail.containerKey !== `slack/${input.channelId}`
    ) continue;
    const wakeId = row.detail?.wakeId;
    const id = row.detail?.id;
    if (typeof wakeId === "string" && wakeIds.has(wakeId) && typeof id === "string" && id.length > 0) messageIds.add(id);
  }

  let latest: { readonly message: SlackMessage; readonly decoded: T } | undefined;
  for (const message of input.messages) {
    if (!messageIds.has(message.ts)) continue;
    const decoded = input.decode(message);
    if (decoded !== undefined && (latest === undefined || message.ts > latest.message.ts)) latest = { message, decoded };
  }
  return latest;
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
    declaredLabel: `audited silence (declared audit.silences): a ${surfaceAction}/unified.no_reply row exists for the run (the FULL-DETAIL judged-silence row this target declares it writes)`,
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
    args.log("silence auditing not declared for this target — asserting the ALWAYS-ON reply.no_reply_observed row only; set E2E_AUDIT_SILENCES=1 against an audit.silences deployment to assert the full-detail row too");
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
  const CLASS = `[${LINK_CODE_ALPHABET}]`;
  const PUNCT = "[\\s:*_`\\-]";
  const anchored = new RegExp(`\\blink${PUNCT}+(${CLASS}{8})\\b`, "i").exec(text);
  if (anchored) return anchored[1]!.toUpperCase();
  for (const line of text.split("\n")) {
    const bare = new RegExp(`^${PUNCT}*(${CLASS}{8})${PUNCT}*$`).exec(line);
    if (bare) return bare[1]!;
  }
  return undefined;
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

export function prOpenRowNumbers(rows: readonly AuditWireEntry[], repo?: string): readonly number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (row.action !== "pr.open") continue;
    const d = row.detail as Record<string, unknown> | undefined;
    if (repo !== undefined && d?.repo !== repo) continue;
    const n = d?.number;
    if (typeof n === "number" && Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

export type PrDriveResult =
  | { readonly published: true; readonly arm: "card"; readonly card: SlackMessage; readonly prNumber: number; readonly head: string }
  | { readonly published: true; readonly arm: "judge-allow"; readonly card?: undefined; readonly judge: JudgeAllowEvidence; readonly prNumber: number; readonly head: string }
  | { readonly published: false; readonly miss: "grant-refused" | "errored" | "no-tool"; readonly reason: string };

export const JUDGE_ARM_PROBE_MS = 60_000;

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
  judgeArmProbeMs?: number;
}): Promise<PrDriveResult> {
  const { slack, synthetic, pr, ask, token, base, timeoutMs } = args;
  const decision = args.decision ?? "approve";
  const gate = legGate(args.gate, args.leg);
  const askIso = new Date(Date.now() - 5_000).toISOString();
  const { ts: askTs } = await slack.post(slack.mention(ask));
  const firstReply = await slack.awaitThreadReply(askTs, { timeoutMs });

  let card: SlackMessage | undefined = approveButton(firstReply) !== undefined ? firstReply : undefined;
  if (card === undefined && args.auditRead !== undefined) {
    const auditRead = args.auditRead;
    let seenJudge: JudgeAllowEvidence | undefined;
    let seenNumbers: readonly number[] = [];
    const matched = await pollOptional<{ judge: JudgeAllowEvidence; prNumber: number }>(
      async () => {
        const rows = await auditRead({ sinceIso: askIso, actions: ["approval.judge.verdict", "pr.open"] });
        const judge = findJudgeAllow(rows, "open_pull_request");
        if (judge === undefined) return undefined;
        seenJudge = judge;
        const numbers = prOpenRowNumbers(rows, args.repo);
        if (numbers.length > 0) seenNumbers = numbers;
        for (const n of numbers) {
          if (await pr.prContainsToken(n, token)) return { judge, prNumber: n };
        }
        return undefined;
      },
      { timeoutMs: args.judgeArmProbeMs ?? JUDGE_ARM_PROBE_MS, what: `an approval.judge.verdict allow + a token-carrying pr.open audit row for the card-less "${args.leg}" publish` },
    );
    const found = matched ?? (seenJudge !== undefined && seenNumbers.length > 0 ? { judge: seenJudge, prNumber: seenNumbers[0]! } : undefined);
    if (found !== undefined) {
      const { judge, prNumber } = found;
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
      return { published: true, arm: "judge-allow", judge, prNumber, head: details.head };
    }
  } else if (card === undefined) {
    args.log(
      "no card in the first reply and NO audit read wired — arm (b) is off, so a judge-allow publish would read as a no-tool skip here. Set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN.",
    );
  }

  card ??= await awaitCard(slack, askTs, timeoutMs).catch(() => undefined);
  if (!card) {
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
  return { published: true, arm: "card", card, prNumber, head: details.head };
}
