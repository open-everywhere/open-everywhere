import { GRANT_NONE_LIVE_TEXT, grantHoldingPhrase, grantRevokedOwnerText, type GrantHoldingFacts, type GrantRevokedHolding } from "./credential-grant-copy.js";
import { revokeCredentialGrant, type GrantAuditStamps } from "./credential-grant-flow.js";
import { postGrantResolution, type GrantNoticeOutcome } from "./credential-grant-resolution.js";
import { quotedPurpose, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";

export interface OwnerGrantHolding {
  readonly grant: CredentialGrantRow;
  readonly ordinal: number;
  readonly phrase: string;
}

function holdingFacts(grant: CredentialGrantRow, nowMs: number): GrantHoldingFacts {
  return { connector: grant.connector, expiresAt: grant.expiresAt, mcpTool: grant.mcpTool, nowMs, quotedPurpose: quotedPurpose(grant.purpose) };
}

export async function ownerLiveGrants(org: string, ownerPrincipalId: string, nowMs: number): Promise<readonly OwnerGrantHolding[]> {
  const rows = await getOperationalStore().liveCredentialGrantsForOwner(org, ownerPrincipalId, new Date(nowMs).toISOString());
  return rows.map((grant, i) => ({ grant, ordinal: i + 1, phrase: grantHoldingPhrase(holdingFacts(grant, nowMs)) }));
}

export function ownerGrantListText(holdings: readonly OwnerGrantHolding[]): string {
  if (holdings.length === 0) return GRANT_NONE_LIVE_TEXT;
  return [
    `You are lending your account to ${holdings.length === 1 ? "one conversation" : `${String(holdings.length)} conversations`}:`,
    ...holdings.map((h) => `${String(h.ordinal)}. ${h.phrase}`),
    "",
    "Say which number to end, and I will end it now. Ending one is immediate and it cannot be undone — a fresh ask would have to be approved again.",
  ].join("\n");
}

export interface GrantRevokeOutcome {
  readonly ended: readonly CredentialGrantRow[];
  readonly remaining: readonly OwnerGrantHolding[];
  readonly text: string;
  readonly notices: readonly GrantNoticeOutcome[];
}

export async function revokeOwnerGrants(
  stamps: GrantAuditStamps,
  ownerPrincipalId: string,
  which: readonly number[] | undefined,
  nowMs: number,
): Promise<GrantRevokeOutcome> {
  const holdings = await ownerLiveGrants(stamps.org, ownerPrincipalId, nowMs);
  const wanted = which === undefined ? holdings : holdings.filter((h) => which.includes(h.ordinal));
  const ended: CredentialGrantRow[] = [];
  const endedHoldings: GrantRevokedHolding[] = [];
  const notices: GrantNoticeOutcome[] = [];
  for (const holding of wanted) {
    if (!(await revokeCredentialGrant(stamps, holding.grant.id, ownerPrincipalId, "thread", nowMs))) continue;
    ended.push(holding.grant);
    const notice = await tellBorrowingRoom(stamps.org, holding.grant, nowMs);
    notices.push(notice);
    endedHoldings.push({ phrase: holding.phrase, told: notice === "sent" });
  }
  const remaining = await ownerLiveGrants(stamps.org, ownerPrincipalId, nowMs);
  return { ended, notices, remaining, text: grantRevokedOwnerText(endedHoldings, remaining.map((h) => h.phrase)) };
}

async function tellBorrowingRoom(org: string, grant: CredentialGrantRow, nowMs: number): Promise<GrantNoticeOutcome> {
  const ask = await getOperationalStore().getCredentialGrantAsk(org, grant.askId);
  if (ask === null) return "no_target";
  return await postGrantResolution(ask, { kind: "revoked" }, nowMs);
}
