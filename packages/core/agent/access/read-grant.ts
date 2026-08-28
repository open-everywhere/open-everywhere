import type { EffectiveAccess } from "./resolver.js";
import { SURFACE_KEY, TENANT_KEY, type Scope } from "./bundle.js";

export type ReadableBy = readonly Scope[];

export type ReadGrantSubject = Pick<EffectiveAccess, "tenantKey" | "domains" | "surfaceKey">;

export function scopeGrantsRead(readableBy: ReadableBy | undefined, access: ReadGrantSubject): boolean {
  if (!readableBy || readableBy.length === 0) return false;
  return readableBy.some((s) => {
    switch (s.level) {
      case "org":
        return true;
      case "tenant":
        return s.tenant !== undefined && s.tenant === access.tenantKey;
      case "domain":
        return s.domain !== undefined && access.domains.includes(s.domain);
      case "surface":
        return s.surface !== undefined && s.surface === access.surfaceKey;
      case "principal":
        return false;
      default:
        return false;
    }
  });
}

export function readableByDefects(readableBy: ReadableBy | undefined): readonly string[] {
  const bad: string[] = [];
  if (!readableBy || readableBy.length === 0) {
    bad.push(
      'readableBy is empty — a hook readable by nobody accepts deliveries and then refuses every routine, silently and forever. Name the domain(s) that may read it, or `{ level: "org" }` for EVERY domain in the org.',
    );
    return bad;
  }
  for (const s of readableBy) {
    const where = `readableBy entry (${s.level} scope)`;
    switch (s.level) {
      case "org":
        for (const [field, value] of [["tenant", s.tenant], ["domain", s.domain], ["surface", s.surface], ["principal", s.principal]] as const) {
          if (value !== undefined) bad.push(`${where} also sets ${field} — org scope already means EVERY domain and carries no address field; drop it or change the level`);
        }
        break;
      case "tenant":
        if (!s.tenant) bad.push(`${where} needs tenant — a tenant-level grant can never match without one`);
        else if (!TENANT_KEY.test(s.tenant)) {
          bad.push(`${where} tenant "${s.tenant}" must be the PLATFORM-QUALIFIED key "platform/<tenant-id>" (e.g. "slack/T0123ABC") — a bare vendor id will NEVER match`);
        }
        break;
      case "domain":
        if (!s.domain) bad.push(`${where} needs domain — a domain-level grant can never match without one`);
        else if (s.domain.includes("/")) {
          bad.push(`${where} domain "${s.domain}" contains "/" — a domain scope takes the BARE name from memory/config/domains.ts ("payments"), deliberately NOT tenant-qualified`);
        }
        break;
      case "surface":
        if (!s.surface) bad.push(`${where} needs surface — a surface-level grant can never match without one`);
        else if (!SURFACE_KEY.test(s.surface)) {
          bad.push(`${where} surface "${s.surface}" must be the fully-qualified key "platform/<tenant-id>/<container-id>" (e.g. "slack/T0123ABC/C0123ABC")`);
        }
        break;
      case "principal":
        bad.push(
          `${where} is principal-scoped — a DM is a separate connector universe and never reads a service-plane webhook. Grant a domain or a surface instead.`,
        );
        break;
      default:
        bad.push(`${where} has an unknown level ${JSON.stringify((s as Scope).level)} — the levels are org | tenant | domain | surface`);
    }
  }
  return bad;
}

export function describeReadableBy(readableBy: ReadableBy | undefined): string {
  if (!readableBy || readableBy.length === 0) return "NOBODY (no routine can ever read this hook's events)";
  const parts = readableBy.map((s) => {
    switch (s.level) {
      case "org":
        return "EVERY domain in the org";
      case "tenant":
        return `every domain in tenant ${s.tenant}`;
      case "domain":
        return `domain "${s.domain}"`;
      case "surface":
        return `surface ${s.surface}`;
      case "principal":
        return `principal ${s.principal} (never grants — see readableByDefects)`;
      default:
        return JSON.stringify(s);
    }
  });
  return [...new Set(parts)].join(", ");
}
