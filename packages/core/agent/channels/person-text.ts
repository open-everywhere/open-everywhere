import { rawIdLeaks } from "./friendly-ids.js";

export const TURN_FAILED_TEXT = "Sorry, something went wrong and I couldn't finish that. Please try again.";

export const COMMAND_FAILED_TEXT = "Sorry, that didn't work. Please try again in a moment.";

export class PersonFacingError extends Error {
  override readonly name = "PersonFacingError";
}

export function commandFailureText(err: unknown): string {
  return err instanceof PersonFacingError ? err.message : COMMAND_FAILED_TEXT;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export function friendlyWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

export function friendlyMonth(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : period;
}

const OTHER_ID_SHAPES: readonly RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\br-[0-9a-f]{6,}\b/g,
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/g,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g,
];

const DEBUG_TERMS: readonly RegExp[] = [
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:TOKEN|KEY|SECRET|URL|ID|PATH)\b/g,
  /deployment logs?/gi,
  /\bstack trace\b/gi,
  /\b(?:TypeError|ReferenceError|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/g,
  /\bmissing_scope\b/g,
  /\bundefined\b|\bnull\b/g,
  /\bcontrol[- ]plane\b/gi,
  /\bzero-inference\b/gi,
  /\bconfig-as-code\b/gi,
  /\bpending `?[0-9a-f]{4,}/gi,
  /\bspend ledger\b/gi,
  /\bcompaction\b/gi,
  /\bscope key\b/gi,
  /\bsynthetic context\b/gi,
  /agent\/memory\/config\//g,
  /\bwired\b/gi,
];

const TRUST_PLUMBING: readonly RegExp[] = [
  /\baudience floor\b/gi,
  /\bprovenance\b/gi,
  /\bingested\b/gi,
  /\bexternal content\b/gi,
  /\bnever as (?:an )?instructions?\b/gi,
  /\bas data\b/gi,
  /\btaint(?:ed)?\b/gi,
  /\bapprover chain\b/gi,
  /\bapproval judge\b/gi,
  /\baudit (?:trail|row|log)\b/gi,
  /\bseat\b/gi,
  /\bfail[- ]closed\b/gi,
  /\bunverified claim\b/gi,
  /\bbreak-glass\b/gi,
  /\bpseudo-domain\b/gi,
  /\bmemory domain\b/gi,
];

export function personTextFaults(text: string): string[] {
  const found = rawIdLeaks(text).map((m) => `raw id: ${m}`);
  const visible = text.replace(/<[@#!][^>\s]+>|<https?:\/\/[^>\s]+>|https?:\/\/\S+/g, " ");
  for (const shape of OTHER_ID_SHAPES) for (const m of visible.matchAll(shape)) found.push(`raw id: ${m[0]}`);
  for (const shape of DEBUG_TERMS) for (const m of visible.matchAll(shape)) found.push(`debug: ${m[0]}`);
  for (const shape of TRUST_PLUMBING) for (const m of visible.matchAll(shape)) found.push(`plumbing: ${m[0]}`);
  return found;
}
