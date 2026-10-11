import { processRegistrySlot } from "../lib/process-registry.js";
import type { Trust } from "../identity/binding.js";
import type { SessionMode } from "../access/resolver.js";

export interface PersonalBrowserPolicy {
  readonly enabled: boolean;
  readonly box: { readonly image: string; readonly vcpus: number; readonly memoryMb: number; readonly dockerNetwork?: string };
  readonly sessionMinutes: number;
  readonly idleMinutes: number;
  readonly keepLoginsDays: number;
  readonly takeoverMinutes: number;
  readonly actGrantMinutes: number;
}

export const DEFAULT_PERSONAL_BROWSER_POLICY: PersonalBrowserPolicy = Object.freeze({
  enabled: false,
  box: Object.freeze({ image: "oe-personal-browser", vcpus: 2, memoryMb: 4096 }),
  sessionMinutes: 120,
  idleMinutes: 15,
  keepLoginsDays: 30,
  takeoverMinutes: 30,
  actGrantMinutes: 60,
});

const MAX_SESSION_MINUTES = 24 * 60;

export function personalBrowserPolicyProblems(p: PersonalBrowserPolicy): readonly string[] {
  const problems: string[] = [];
  const int = (v: unknown, lo: number, hi: number, name: string): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) problems.push(`${name} must be an integer from ${lo} to ${hi}`);
  };
  if (typeof p.enabled !== "boolean") problems.push("enabled must be true or false");
  if (typeof p.box?.image !== "string" || p.box.image.trim().length === 0 || /\s/.test(p.box.image)) problems.push("box.image must name an image");
  int(p.box?.vcpus, 1, 8, "box.vcpus");
  int(p.box?.memoryMb, 1024, 32768, "box.memoryMb");
  if (p.box?.dockerNetwork !== undefined && (typeof p.box.dockerNetwork !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(p.box.dockerNetwork))) {
    problems.push("box.dockerNetwork must be a docker network name");
  }
  int(p.sessionMinutes, 5, MAX_SESSION_MINUTES, "sessionMinutes");
  int(p.idleMinutes, 5, 240, "idleMinutes");
  int(p.keepLoginsDays, 1, 90, "keepLoginsDays");
  int(p.takeoverMinutes, 1, 240, "takeoverMinutes");
  int(p.actGrantMinutes, 1, 480, "actGrantMinutes");
  if (typeof p.idleMinutes === "number" && typeof p.sessionMinutes === "number" && p.idleMinutes > p.sessionMinutes) {
    problems.push("idleMinutes must not exceed sessionMinutes");
  }
  return problems;
}

export function definePersonalBrowserPolicy(p: PersonalBrowserPolicy): PersonalBrowserPolicy {
  const problems = personalBrowserPolicyProblems(p);
  if (problems.length > 0) {
    throw new Error(`personal browser policy is unusable — the personal browser stays OFF (fail closed):\n${problems.map((x) => `  - ${x}`).join("\n")}`);
  }
  return Object.freeze({ ...p, box: Object.freeze({ ...p.box }) });
}

const SLOT = processRegistrySlot<PersonalBrowserPolicy>("personal-browser-policy.v1");

export function registerPersonalBrowserPolicy(p: PersonalBrowserPolicy): void {
  SLOT.set(definePersonalBrowserPolicy(p));
}

export function personalBrowserPolicy(): PersonalBrowserPolicy {
  return SLOT.get() ?? DEFAULT_PERSONAL_BROWSER_POLICY;
}

export function resetPersonalBrowserPolicyForTest(): void {
  SLOT.set(null);
}

export interface PersonalBrowserAsk {
  readonly mode: SessionMode;
  readonly trust: Trust;
  readonly nonMember: boolean;
  readonly actingPrincipal: string | undefined;
}

export function personalBrowserRefusal(policy: PersonalBrowserPolicy, ask: PersonalBrowserAsk): string | undefined {
  if (!policy.enabled) return "the personal browser is not enabled on this deployment — an admin turns it on in agent/personal-browser/policy.ts";
  if (ask.mode !== "dm") {
    return "your browser holds your own signed-in sessions, so it only works in your direct message with me — never in a channel or a group DM. Ask me there";
  }
  if (ask.trust !== "internal") {
    return "this direct message is not confirmed internal (a guest or an outside account), so I won't open a browser with signed-in sessions from here";
  }
  if (ask.nonMember) return "a message from someone outside the workspace woke this turn, so I won't use your browser from it";
  if (ask.actingPrincipal === undefined) return "your browser needs you in the conversation — a triggered routine fire has nobody whose browser it could use";
  return undefined;
}
