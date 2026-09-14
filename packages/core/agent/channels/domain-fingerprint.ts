import { createHash } from "node:crypto";
import { getConfig } from "../access/config.js";
import { domainForChannel, type Domain } from "../memory/domain.js";

export const NO_DOMAIN_FINGERPRINT = "no-domain";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new Error(`domain declaration holds a ${kind}, which no stable hash can cover`);
  }
  if (kind === "string" || kind === "number" || kind === "boolean") return JSON.stringify(value);
  if (kind === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
}

export function domainFingerprint(domain: Domain | undefined): string {
  if (!domain) return NO_DOMAIN_FINGERPRINT;
  return createHash("sha256").update(canonicalJson(domain)).digest("hex").slice(0, 16);
}

export function domainFingerprintForSeat(domainName: string | undefined, surfaceKey: string): string | undefined {
  try {
    const domains = getConfig().loadDomains();
    if (domainName === undefined) return domainFingerprint(domainForChannel(surfaceKey, domains));
    const named = domains.find((d) => d.name === domainName);
    if (!named) throw new Error(`the seat is grained by domain "${domainName}", which the loaded config does not declare`);
    return domainFingerprint(named);
  } catch (err) {
    console.warn(`[open-everywhere:runtime-rotation] domain fingerprint unavailable for ${domainName ?? surfaceKey}: ${String(err)} — resuming the current generation`);
    return undefined;
  }
}
