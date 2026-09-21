import type { CredentialGrantFamily } from "../access/connector-credentials.js";

export interface OwnAccountVendor {
  readonly connector: string;
  readonly aliases?: readonly string[];
}

export interface OwnAccountAsk {
  readonly connector: string;
  readonly ambiguous: boolean;
}

const ACCOUNT_NOUN_RE = "(?:account|login|credential|credentials|oauth|token)";

const OWN_POSSESSIVE_RE = new RegExp(String.raw`\bmy\s+(?:own|personal)\s+${ACCOUNT_NOUN_RE}\b`);

const VENDOR_ADJACENCY_WORDS = 3;

const TEAM_ACCOUNT_RE =
  /\b(?:team|org|organisation|organization|shared|company|workspace|deployment|default)(?:'s)?\s+(?:\S+\s+)?(?:account|integration|credential|credentials|key|token|login)\b/;

function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function vendorWords(vendor: OwnAccountVendor): readonly string[] {
  return [vendor.connector, ...(vendor.aliases ?? [])]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function vendorPossessiveRe(vendor: OwnAccountVendor): RegExp {
  return new RegExp(String.raw`\bmy\s+(?:own\s+|personal\s+)?(?:${vendorWords(vendor).join("|")})\s+${ACCOUNT_NOUN_RE}\b`);
}

function possessiveBoundToVendor(lower: string, vendor: OwnAccountVendor): boolean {
  const match = OWN_POSSESSIVE_RE.exec(lower);
  if (match === null) return false;
  const before = lower.slice(0, match.index).split(/\s+/).filter(Boolean).slice(-VENDOR_ADJACENCY_WORDS);
  const after = lower
    .slice(match.index + match[0].length)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, VENDOR_ADJACENCY_WORDS);
  const window = [...before, ...after].join(" ");
  return vendorWords(vendor).some((w) => new RegExp(w).test(window));
}

function sentenceNamesOwnAccount(sentence: string, vendor: OwnAccountVendor): boolean {
  const lower = sentence.toLowerCase();
  if (!vendorWords(vendor).some((w) => new RegExp(w).test(lower))) return false;
  return vendorPossessiveRe(vendor).test(lower) || possessiveBoundToVendor(lower, vendor);
}

export function namedOwnAccountVendor(messages: readonly string[], vendors: readonly OwnAccountVendor[]): OwnAccountAsk | undefined {
  for (const message of messages) {
    for (const sentence of sentencesOf(message)) {
      for (const vendor of vendors) {
        if (!sentenceNamesOwnAccount(sentence, vendor)) continue;
        return { ambiguous: TEAM_ACCOUNT_RE.test(sentence.toLowerCase()), connector: vendor.connector };
      }
    }
  }
  return undefined;
}

export type ActingIdentityReason =
  | "no-own-account-ask"
  | "own-account-ask-grant-held"
  | "own-account-ask-no-grant"
  | "own-account-ask-ambiguous";

export interface ActingIdentityVerdict {
  readonly requiredIdentity: CredentialGrantFamily;
  readonly identity?: CredentialGrantFamily;
  readonly reason: ActingIdentityReason;
  readonly refusal?: string;
  readonly askRecognised: boolean;
}

export interface ActingIdentityInput {
  readonly connector: string;
  readonly ask?: OwnAccountAsk;
  readonly personalGrantHeld: boolean;
  readonly consentRouteAvailable: boolean;
  readonly deploymentAdmitsGrant: boolean;
  readonly callerCanSpendPersonal: boolean;
}

export function decideActingIdentity(input: ActingIdentityInput): ActingIdentityVerdict {
  if (input.ask === undefined) return { askRecognised: false, identity: "install", reason: "no-own-account-ask", requiredIdentity: "install" };
  if (input.ask.ambiguous) {
    return {
      askRecognised: true,
      reason: "own-account-ask-ambiguous",
      refusal: ambiguousAccountRefusal(input.connector),
      requiredIdentity: "human-acting",
    };
  }
  if (input.personalGrantHeld) {
    return {
      askRecognised: true,
      reason: "own-account-ask-grant-held",
      requiredIdentity: "human-acting",
      ...(input.callerCanSpendPersonal ? { identity: "human-acting" as const } : { refusal: personalRouteRefusal(input.connector) }),
    };
  }
  return {
    askRecognised: true,
    reason: "own-account-ask-no-grant",
    refusal: ownAccountRefusal(input.connector, input.consentRouteAvailable, input.deploymentAdmitsGrant),
    requiredIdentity: "human-acting",
  };
}

export function ownAccountRefusal(connector: string, consentRouteAvailable: boolean, deploymentAdmitsGrant: boolean): string {
  const opening =
    `Refused: this request asks to act with the requester's own ${connector} account, and this chat holds no personal ` +
    `${connector} grant. Reading under the deployment's ${connector} integration would answer as the org, not as them, ` +
    `and they would have no way to see the difference.`;
  const route = consentRouteAvailable
    ? `Hand this to a task: the task raises the ask with \`request_credential_grant\`, which lives there and nowhere else. ` +
      `Then tell the room the ask went out.`
    : deploymentAdmitsGrant
      ? `This chat cannot raise a personal ${connector} grant — no domain here admits one — so there is no consent flow to start.`
      : `This deployment cannot lend a personal ${connector} account at all: ${connector} admits no credential grant, so ` +
        `there is no consent flow to start and no domain setting opens one. Do not tell them to connect their account.`;
  const fallback =
    `Otherwise say plainly, in the room, that you cannot act as them on ${connector}, and that you will use the shared ` +
    `${connector} integration only if they agree to it. Do not read under the shared integration until they say so.`;
  return `${opening} ${route} ${fallback}`;
}

export function ambiguousAccountRefusal(connector: string): string {
  return (
    `Refused: this request names the requester's own ${connector} account AND the shared ${connector} integration in one ` +
    `sentence, so which account to act with cannot be read off it. Ask them in the room which they mean. Do not choose ` +
    `for them — the two see different pages, and the answer would not say which one it came from.`
  );
}

export function personalRouteRefusal(connector: string): string {
  return (
    `Refused: this request asks to act with the requester's own ${connector} account, and they have already lent it to ` +
    `this chat. This tool reads under the deployment's shared ${connector} integration, so running it here would answer ` +
    `as the org after they said "as me". The granted \`grant__…_${connector}__…\` tool is the one that runs under their ` +
    `credential, and it lives on this conversation's TASKS. Hand the read to a task.`
  );
}

export const CONNECTOR_OWN_ACCOUNT_ASK_ACTION = "connector.own_account_ask";

const OWN_ACCOUNT_REQUIRED_IDENTITY: CredentialGrantFamily = "human-acting";

export function ownAccountAskAuditDetail(ask: OwnAccountAsk, stamped: boolean): Record<string, unknown> {
  return {
    askRecognised: true,
    connector: ask.connector,
    outcome: ask.ambiguous ? "refuse-ambiguous" : "refuse-unless-grant-held",
    requiredIdentity: OWN_ACCOUNT_REQUIRED_IDENTITY,
    stamped,
  };
}

export function actingIdentityAuditDetail(verdict: ActingIdentityVerdict, connector: string, tool: string): Record<string, unknown> {
  return {
    askRecognised: verdict.askRecognised,
    connector,
    ...(verdict.identity === undefined ? {} : { identity: verdict.identity }),
    reason: verdict.reason,
    refused: verdict.refusal !== undefined,
    requiredIdentity: verdict.requiredIdentity,
    tool,
  };
}
