const CONNECTOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  notion: "Notion",
};

export function connectorDisplayName(connector: string): string {
  const known = Object.prototype.hasOwnProperty.call(CONNECTOR_DISPLAY_NAMES, connector) ? CONNECTOR_DISPLAY_NAMES[connector] : undefined;
  if (known !== undefined) return known;
  const flat = labelWithoutIds(connector);
  return flat.length === 0 ? "that connector" : `${flat.slice(0, 1).toUpperCase()}${flat.slice(1)}`;
}

const GRANT_ACTION_PHRASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  notion: { "notion-fetch": "read a Notion page" },
};

function reviewedActionPhrase(connector: string, mcpTool: string | undefined): string | undefined {
  const perConnector = Object.prototype.hasOwnProperty.call(GRANT_ACTION_PHRASES, connector) ? GRANT_ACTION_PHRASES[connector] : undefined;
  if (perConnector === undefined || mcpTool === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(perConnector, mcpTool) ? perConnector[mcpTool] : undefined;
}

export function grantActionPhrase(connector: string, mcpTool: string | undefined): string {
  return reviewedActionPhrase(connector, mcpTool) ?? `read one thing in ${connectorDisplayName(connector)}`;
}

export function grantActionIsReviewed(connector: string, mcpTool: string | undefined): boolean {
  return reviewedActionPhrase(connector, mcpTool) !== undefined;
}

export const GRANT_ID_LEAK_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "a minted tool name", re: /grant__/u },
  { name: "a bare 17-20 digit id", re: /(?<![\w-])\d{17,20}(?![\w-])/u },
  { name: "a uuid", re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu },
  { name: "an ISO instant", re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u },
];

function labelWithoutIds(label: string | undefined): string {
  const flat = (label ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, LABEL_MAX);
  return GRANT_ID_LEAK_PATTERNS.some(({ re }) => re.test(flat)) ? "" : flat;
}

const LABEL_MAX = 120;

export function grantConversationPhrase(label: string | undefined): string {
  const flat = labelWithoutIds(label);
  return flat.length === 0 ? "that conversation" : `the ${flat} conversation`;
}

export function grantRequesterPhrase(label: string | undefined): string {
  return grantDisplayLabel(label) ?? "Someone this deployment cannot name";
}

export function grantDisplayLabel(label: string | undefined): string | undefined {
  const flat = labelWithoutIds(label);
  return flat.length === 0 ? undefined : flat;
}

export function grantOwnerPhrase(ownerSlug: string | undefined): string {
  const flat = labelWithoutIds(ownerSlug);
  return flat.length === 0 ? "the owner" : flat;
}

export function grantClockPhrase(atIso: string): string | undefined {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return undefined;
  const d = new Date(at);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function grantExpiryPhrase(expiresAtIso: string, nowMs: number): string {
  const at = Date.parse(expiresAtIso);
  if (!Number.isFinite(at)) return "until it expires";
  const remaining = at - nowMs;
  if (remaining <= 0) return "until it expires (it already has)";
  return `for the next ${grantSpanWords(remaining)} (until ${grantClockWords(new Date(at), remaining)})`;
}

function grantSpanWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return plural(Math.max(1, minutes), "minute");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return plural(hours, "hour");
  return plural(Math.round(ms / 86_400_000), "day");
}

function grantClockWords(at: Date, remainingMs: number): string {
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
  if (remainingMs < 36 * 3_600_000) return clock;
  return `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ""}, ${clock}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

export interface GrantHoldingFacts {
  readonly connector: string;
  readonly mcpTool: string | undefined;
  readonly quotedPurpose: string;
  readonly expiresAt: string;
  readonly nowMs: number;
}

export function grantHoldingPhrase(facts: GrantHoldingFacts): string {
  const action = grantActionPhrase(facts.connector, facts.mcpTool);
  const reason = facts.quotedPurpose.length === 0 ? "" : ` They asked for it to "${facts.quotedPurpose}".`;
  return `${action.slice(0, 1).toUpperCase()}${action.slice(1)}, ${grantExpiryPhrase(facts.expiresAt, facts.nowMs)}.${reason}`;
}

export const GRANT_NONE_LIVE_TEXT =
  "I can see nothing you are lending from the account you are messaging me with. If you approved a grant from a different account, ask me there.";

export interface GrantRevokedHolding {
  readonly phrase: string;
  readonly told: boolean;
}

export function grantRevokedOwnerText(ended: readonly GrantRevokedHolding[], remaining: readonly string[]): string {
  if (ended.length === 0) {
    return "Nothing was ended — none of those numbers matched a grant you are still lending. Ask me to list them again and pick from that list.";
  }
  const lead = ended.length === 1 ? "That grant is ended." : `${String(ended.length)} grants are ended.`;
  const one = ended.length === 1;
  const untold = ended.filter((holding) => !holding.told).length;
  const toldClause =
    untold === 0
      ? `The conversation that held ${one ? "it" : "them"} has been told, and the next call it tries is refused.`
      : untold === ended.length
        ? `I could not reach the conversation that held ${one ? "it" : "them"}, so ${one ? "it has" : "they have"} not been told. The next call ${one ? "it tries is" : "they try is"} refused either way.`
        : "I told the conversations I could reach and marked the rest below. The next call any of them tries is refused either way.";
  const what = ended.map((holding) => (holding.told ? `• ${holding.phrase}` : `• ${holding.phrase} — not told, I could not reach that conversation`)).join("\n");
  const rest =
    remaining.length === 0
      ? "You are not lending your account to anything now."
      : [
          `You still lend ${remaining.length === 1 ? "one grant" : `${String(remaining.length)} grants`}:`,
          ...remaining.map((phrase, i) => `${String(i + 1)}. ${phrase}`),
          "These numbers are NEW — ending a grant renumbers the rest. Use the numbers in this list, never the ones from before.",
        ].join("\n");
  return `${lead} ${toldClause}\n${what}\n\n${rest}`;
}

export function grantRevokedRoomText(connector: string, mcpTool: string | undefined): string {
  return (
    `The owner has ended the credential grant this conversation held — it can no longer ${grantActionPhrase(connector, mcpTool)} with their ` +
    `${connectorDisplayName(connector)} account. The borrowed tool may still appear in your tool list; every call on it is now refused. ` +
    "Do not ask for it again unless somebody here asks you to."
  );
}

export type GrantCopyAudience = "owner" | "seat";

export interface GrantDuplicateFacts {
  readonly connector: string;
  readonly mcpTool: string | undefined;
  readonly expiresAt: string | undefined;
  readonly nowMs: number;
  readonly ownerLabel: string | undefined;
  readonly conversationLabel: string | undefined;
}

export function grantDuplicateRefusalText(audience: GrantCopyAudience, facts: GrantDuplicateFacts): string {
  const action = grantActionPhrase(facts.connector, facts.mcpTool);
  const when = facts.expiresAt === undefined ? "" : `, ${grantExpiryPhrase(facts.expiresAt, facts.nowMs)}`;
  const holder = grantConversationPhrase(facts.conversationLabel);
  const from = audience === "owner" ? "from you" : `from ${grantRequesterPhrase(facts.ownerLabel)}`;
  const again =
    audience === "owner"
      ? "You can end it early — send me a direct message and ask. Until then a new request stays refused while this one is live."
      : `Only ${grantRequesterPhrase(facts.ownerLabel)} can end it early, so a new request stays refused while this one is live.`;
  const lead = holder === "that conversation" ? "That conversation" : holder.replace(/^the /u, "The ");
  return `${lead} already has this grant ${from} (${action}${when}). Nothing new was requested — use the grant that is already there. ${again}`;
}
