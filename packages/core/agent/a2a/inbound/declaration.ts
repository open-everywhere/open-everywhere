import { processRegistrySlot } from "../../lib/process-registry.js";

export const A2A_INBOUND_PLATFORM = "a2a";
export const A2A_INBOUND_WORKSPACE = "inbound";

export interface A2aInboundJwtAuth {
  readonly scheme: "jwt";
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
  readonly subject: string;
}

export interface A2aInboundBearerAuth {
  readonly scheme: "bearer";
  readonly secretRef: string;
  readonly broker?: string;
}

export type A2aInboundAuth = A2aInboundJwtAuth | A2aInboundBearerAuth;

export interface A2aInboundCaller {
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  readonly auth: A2aInboundAuth;
}

export interface A2aInboundSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly examples?: readonly string[];
}

export interface A2aInboundDeclaration {
  readonly name: string;
  readonly description: string;
  readonly skills: readonly A2aInboundSkill[];
  readonly callers: readonly A2aInboundCaller[];
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/u;

export const NO_A2A_INBOUND: A2aInboundDeclaration = Object.freeze({ name: "", description: "", skills: Object.freeze([]), callers: Object.freeze([]) });

function urlProblems(raw: unknown, where: string, field: string): string[] {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return [`${where}: ${field} "${String(raw)}" is not a URL.`];
  }
  const bad: string[] = [];
  if (url.protocol !== "https:") bad.push(`${where}: ${field} must be https — a key source in clear text can be swapped.`);
  if (url.username !== "" || url.password !== "") bad.push(`${where}: ${field} carries a user-info part — a credential in a URL is a secret in Git.`);
  if (url.search !== "") bad.push(`${where}: ${field} carries a query string — a token in a URL is a secret in Git.`);
  if (url.hash !== "") bad.push(`${where}: ${field} carries a fragment.`);
  return bad;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function authProblems(auth: A2aInboundAuth | undefined, where: string): string[] {
  if (auth === undefined || auth === null || typeof auth !== "object") return [`${where}: auth is missing — every inbound caller must authenticate; there is no anonymous door.`];
  const a = auth as A2aInboundAuth & { token?: unknown; secret?: unknown; value?: unknown };
  const bad: string[] = [];
  for (const literal of ["token", "secret", "value"] as const) {
    if (literal in a) bad.push(`${where}: auth carries a literal "${literal}" — name the secret's credential-store REF in auth.secretRef instead.`);
  }
  if (a.scheme === "jwt") {
    bad.push(...urlProblems(a.issuer, where, `auth.issuer`), ...urlProblems(a.jwksUrl, where, `auth.jwksUrl`));
    if (!nonEmpty(a.audience)) bad.push(`${where}: auth.audience is empty — a token minted for another audience must not verify here.`);
    if (!nonEmpty(a.subject) || a.subject.includes("*")) bad.push(`${where}: auth.subject must name exactly one subject (no wildcard).`);
  } else if (a.scheme === "bearer") {
    if (!nonEmpty(a.secretRef)) bad.push(`${where}: auth.secretRef is empty — name the REF of the secret, never the value.`);
    if (a.broker !== undefined && !nonEmpty(a.broker)) bad.push(`${where}: auth.broker is empty — omit it for the default "db" broker.`);
  } else {
    bad.push(`${where}: auth.scheme "${String((a as { scheme?: unknown }).scheme)}" is not a supported scheme (jwt, bearer).`);
  }
  return bad;
}

export function defineA2aInbound(decl: A2aInboundDeclaration): A2aInboundDeclaration {
  const bad: string[] = [];
  const callers = decl.callers ?? [];
  const skills = decl.skills ?? [];
  if (callers.length > 0) {
    if (!nonEmpty(decl.name)) bad.push("name is empty — the agent card shows it.");
    if (!nonEmpty(decl.description)) bad.push("description is empty — the agent card shows it.");
    if (skills.length === 0) bad.push("skills is empty — the agent card must list at least one skill a caller may ask for.");
  }
  const skillIds = new Set<string>();
  skills.forEach((s, i) => {
    const where = `skill ${typeof s?.id === "string" ? `"${s.id}"` : `#${i}`}`;
    if (typeof s.id !== "string" || !NAME.test(s.id)) bad.push(`${where}: id must match ${NAME}.`);
    if (!nonEmpty(s.name)) bad.push(`${where}: name is empty.`);
    if (!nonEmpty(s.description)) bad.push(`${where}: description is empty.`);
    if (skillIds.has(s.id)) bad.push(`${where}: declared twice.`);
    skillIds.add(s.id);
  });
  const names = new Set<string>();
  const jwtIdentities = new Set<string>();
  callers.forEach((c, i) => {
    const where = `caller ${typeof c?.name === "string" ? `"${c.name}"` : `#${i}`}`;
    if (typeof c.name !== "string" || !NAME.test(c.name)) bad.push(`${where}: name must match ${NAME} (lowercase, a letter first).`);
    if (!nonEmpty(c.description)) bad.push(`${where}: description is empty — a reviewer reads it to know who the caller is.`);
    if (!nonEmpty(c.domain)) bad.push(`${where}: domain is empty — a caller lands in exactly one declared memory domain.`);
    bad.push(...authProblems(c.auth, where));
    if (names.has(c.name)) bad.push(`${where}: declared twice — one name is one caller.`);
    names.add(c.name);
    if (c.auth?.scheme === "jwt") {
      const id = `${c.auth.issuer}\n${c.auth.audience}\n${c.auth.subject}`;
      if (jwtIdentities.has(id)) bad.push(`${where}: another caller pins the same issuer, audience and subject — one verified identity must name one caller.`);
      jwtIdentities.add(id);
    }
  });
  if (bad.length > 0) {
    throw new Error(`agent/access/a2a-inbound.ts is not valid:\n  ${bad.join("\n  ")}`);
  }
  return Object.freeze({
    name: decl.name,
    description: decl.description,
    skills: Object.freeze(skills.map((s) => Object.freeze({ ...s, ...(s.examples !== undefined ? { examples: Object.freeze([...s.examples]) } : {}) }))),
    callers: Object.freeze(callers.map((c) => Object.freeze({ ...c, auth: Object.freeze({ ...c.auth }) }))),
  });
}

const REGISTRY = processRegistrySlot<A2aInboundDeclaration>("a2a-inbound.v1");

export function registerA2aInbound(decl: A2aInboundDeclaration): void {
  REGISTRY.set(defineA2aInbound(decl));
}

export function a2aInboundDeclaration(): A2aInboundDeclaration {
  return REGISTRY.get() ?? NO_A2A_INBOUND;
}

function findInboundCaller(name: string): A2aInboundCaller | undefined {
  return a2aInboundDeclaration().callers.find((c) => c.name === name);
}

export function a2aInboundSurfaceKey(caller: string): string {
  return `${A2A_INBOUND_PLATFORM}/${A2A_INBOUND_WORKSPACE}/${caller}`;
}

function inboundCallerOfSurfaceKey(surfaceKey: string): string | undefined {
  const prefix = `${A2A_INBOUND_PLATFORM}/${A2A_INBOUND_WORKSPACE}/`;
  if (!surfaceKey.startsWith(prefix)) return undefined;
  const caller = surfaceKey.slice(prefix.length);
  return NAME.test(caller) ? caller : undefined;
}

export function inboundDomainForSurfaceKey(surfaceKey: string): string | undefined {
  const caller = inboundCallerOfSurfaceKey(surfaceKey);
  return caller === undefined ? undefined : findInboundCaller(caller)?.domain;
}

export function a2aInboundDomainProblems(decl: A2aInboundDeclaration, domains: readonly { readonly name: string; readonly match?: unknown }[]): string[] {
  return decl.callers
    .filter((c) => !domains.some((d) => d.name === c.domain && d.match === undefined))
    .map((c) => `caller "${c.name}": domain "${c.domain}" is not a declared team domain in agent/memory/config/domains.ts — an inbound caller lands in exactly one, with no fallback.`);
}

export function assertA2aInboundDomains(decl: A2aInboundDeclaration, domains: readonly { readonly name: string; readonly match?: unknown }[]): void {
  const bad = a2aInboundDomainProblems(decl, domains);
  if (bad.length > 0) throw new Error(`agent/access/a2a-inbound.ts is not valid:\n  ${bad.join("\n  ")}`);
}
