import { createHash, randomInt } from "node:crypto";

export const LINK_CODE_ALPHABET = "23456789ACDEFGHJKLMNPQRSTUVWXYZ";

export const LINK_CODE_LENGTH = 8;

export const LINK_CHALLENGE_TTL_MS = 10 * 60_000;

export function mintLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return out;
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");
}

const CLAIM_RE = new RegExp(String.raw`^link[\s:]+([${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}})$`, "i");

export function detectLinkClaim(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = CLAIM_RE.exec(text.trim());
  return m ? m[1]!.toUpperCase() : undefined;
}

export function detectAddressedLinkClaim(text: string | undefined, addressTokens: readonly string[] = []): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const bare = detectLinkClaim(trimmed);
  if (bare) return bare;
  const rest = stripLeadingAddress(trimmed, addressTokens);
  return rest === undefined ? undefined : detectLinkClaim(rest);
}

const ADDRESS_SEP = String.raw`[\s,:]+`;

function stripLeadingAddress(text: string, addressTokens: readonly string[]): string | undefined {
  const mention = new RegExp(String.raw`^(?:<@[!&]?[^>\s]+>|@[\p{L}\p{N}][\p{L}\p{N}_.-]*)${ADDRESS_SEP}`, "u");
  const m = mention.exec(text);
  if (m) return text.slice(m[0].length);
  for (const tok of addressTokens) {
    const t = tok.trim();
    if (t.length < 2) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*");
    const re = new RegExp(String.raw`^${escaped}(?=$|[^\p{L}\p{N}_])${ADDRESS_SEP}`, "iu");
    const mm = re.exec(text);
    if (mm) return text.slice(mm[0].length);
  }
  return undefined;
}

export function linkClaimInstructions(code: string, ttlMinutes: number): string {
  return (
    `From your OTHER account, send me a message whose ENTIRE text is exactly this line and nothing ` +
    `else — @mention me or DM me from that account so the message is addressed to me (a bare, ` +
    `unaddressed line buried in a busy channel will not count):\n\n    link ${code}\n\n` +
    `It is single-use and expires in ${ttlMinutes} minutes. When it lands I will come back HERE, ` +
    `in this DM, and name the account that claimed it — the link is only written once you confirm ` +
    `that in this conversation. If a name you do not recognise comes back, deny it.`
  );
}
