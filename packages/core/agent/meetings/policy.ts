import { processRegistrySlot } from "../lib/process-registry.js";
import { secretNameRefusal } from "../credentials/operator-secrets.js";
import type { Trust } from "../identity/binding.js";
import { PLATFORM_HOSTS, SNOWFLAKE, platformLabel, type MeetingPlatform, type ParsedMeetingLink } from "./link.js";

export interface MeetingHostRule {
  readonly platform: MeetingPlatform;
  readonly host: string;
  readonly tenants?: readonly string[];
  readonly owner?: "unverifiable";
  readonly zoom?: { readonly reviewedApp: string };
  readonly guilds?: readonly string[];
  readonly why: string;
}

export interface MeetingTranscription {
  readonly route: "gateway" | "box";
  readonly model?: string;
}

export interface MeetingPolicy {
  readonly enabled: boolean;
  readonly hosts: readonly MeetingHostRule[];
  readonly botName: string;
  readonly maxMinutes: number;
  readonly leaveWhenAloneMinutes: number;
  readonly retention: {
    readonly audioMinutes: number;
    readonly transcriptDays: number;
  };
  readonly box: { readonly image: string; readonly vcpus: number; readonly memoryMb: number };
  readonly transcription: MeetingTranscription;
  readonly native: NativeTranscriptPolicy;
}

export interface NativeTranscriptPolicy {
  readonly enabled: boolean;
  readonly watchHours: number;
  readonly teams?: {
    readonly tenants: readonly string[];
    readonly clientId: string;
    readonly clientSecretRef: string;
    readonly why: string;
  };
  readonly meet?: {
    readonly domains: readonly string[];
    readonly serviceAccountKeyRef: string;
    readonly why: string;
  };
  readonly zoom?: {
    readonly accountId: string;
    readonly clientId: string;
    readonly clientSecretRef: string;
    readonly why: string;
  };
}

export const DEFAULT_MEETING_POLICY: MeetingPolicy = Object.freeze({
  enabled: false,
  hosts: Object.freeze([]) as readonly MeetingHostRule[],
  botName: "Meeting notetaker",
  maxMinutes: 120,
  leaveWhenAloneMinutes: 5,
  retention: Object.freeze({ audioMinutes: 0, transcriptDays: 30 }),
  box: Object.freeze({ image: "oe-meeting-bot", vcpus: 2, memoryMb: 4096 }),
  transcription: Object.freeze({ route: "gateway" as const, model: "openai/gpt-4o-transcribe" }),
  native: Object.freeze({ enabled: false, watchHours: 24 }),
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_MINUTES_CEILING = 24 * 60;

function hostAllowedFor(platform: MeetingPlatform, host: string): boolean {
  if (platform === "zoom") return host === "zoom.us" || /^[a-z0-9-]+\.zoom\.us$/.test(host);
  return PLATFORM_HOSTS[platform].includes(host);
}

export function meetingPolicyProblems(p: MeetingPolicy): readonly string[] {
  const problems: string[] = [];
  const int = (v: unknown, lo: number, hi: number, name: string): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) problems.push(`${name} must be an integer from ${lo} to ${hi}`);
  };
  if (typeof p.enabled !== "boolean") problems.push("enabled must be true or false");
  if (typeof p.botName !== "string" || p.botName.trim().length === 0 || p.botName.length > 60) problems.push("botName must be 1 to 60 characters");
  int(p.maxMinutes, 5, MAX_MINUTES_CEILING, "maxMinutes");
  int(p.leaveWhenAloneMinutes, 1, 60, "leaveWhenAloneMinutes");
  if (p.retention?.audioMinutes !== 0) problems.push("retention.audioMinutes must be 0: OE never stores meeting audio, so it cannot keep audio for any window");
  int(p.retention?.transcriptDays, 1, 90, "retention.transcriptDays");
  if (typeof p.box?.image !== "string" || p.box.image.trim().length === 0 || /\s/.test(p.box.image)) problems.push("box.image must name an image");
  int(p.box?.vcpus, 1, 8, "box.vcpus");
  int(p.box?.memoryMb, 1024, 32768, "box.memoryMb");
  const route = p.transcription?.route;
  if (route !== "gateway" && route !== "box") problems.push(`transcription.route must be "gateway" or "box"`);
  if (route === "gateway" && (typeof p.transcription.model !== "string" || !/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(p.transcription.model))) {
    problems.push(`transcription.model must be a gateway model id like "openai/gpt-4o-transcribe" for the gateway route`);
  }
  problems.push(...nativePolicyProblems(p.native));
  if (!Array.isArray(p.hosts)) {
    problems.push("hosts must be a list");
    return problems;
  }
  if (p.enabled && p.hosts.length === 0) problems.push("enabled with no hosts would refuse every meeting — declare at least one host rule, or set enabled: false");
  const seen = new Set<string>();
  for (const rule of p.hosts) {
    const at = `host "${String(rule.host)}"`;
    if (rule.platform !== "meet" && rule.platform !== "teams" && rule.platform !== "zoom" && rule.platform !== "discord") {
      problems.push(`${at}: platform must be meet, teams, zoom or discord`);
      continue;
    }
    if (typeof rule.host !== "string" || !hostAllowedFor(rule.platform, rule.host)) {
      problems.push(`${at}: not a ${platformLabel(rule.platform)} meeting host`);
    }
    if (seen.has(rule.host)) problems.push(`${at}: declared twice`);
    seen.add(rule.host);
    if (typeof rule.why !== "string" || rule.why.trim().length === 0) problems.push(`${at}: say why this deployment joins meetings here`);
    if (rule.platform === "teams") {
      if (!Array.isArray(rule.tenants) || rule.tenants.length === 0) {
        problems.push(`${at}: a Teams rule must list the tenant ids whose meetings OE may join — without them every outside organiser's meeting is joinable`);
      } else {
        for (const t of rule.tenants) if (!GUID.test(t)) problems.push(`${at}: tenant "${t}" is not a lowercase tenant GUID`);
      }
    } else if (rule.tenants !== undefined) {
      problems.push(`${at}: tenants apply to Teams only`);
    }
    if (rule.platform === "discord") {
      if (!Array.isArray(rule.guilds) || rule.guilds.length === 0) {
        problems.push(`${at}: a Discord rule must list the server (guild) ids whose voice channels OE may join`);
      } else {
        for (const g of rule.guilds) if (typeof g !== "string" || !SNOWFLAKE.test(g)) problems.push(`${at}: guild "${String(g)}" is not a Discord server id`);
      }
    } else if (rule.guilds !== undefined) {
      problems.push(`${at}: guilds apply to Discord only`);
    }
    if (rule.platform === "meet" && rule.owner !== "unverifiable") {
      problems.push(`${at}: a Meet link names no organiser, so OE cannot refuse an outside room — set owner: "unverifiable" to accept that in Git, or drop the rule`);
    }
    if (rule.platform === "zoom" && (typeof rule.zoom?.reviewedApp !== "string" || rule.zoom.reviewedApp.trim().length === 0)) {
      problems.push(`${at}: Zoom needs a Zoom-reviewed Meeting SDK app — declare zoom.reviewedApp, or drop the rule`);
    }
  }
  return problems;
}

function nativePolicyProblems(n: NativeTranscriptPolicy | undefined): string[] {
  const problems: string[] = [];
  if (n === undefined || n === null || typeof n !== "object") return ["native must be declared (spread DEFAULT_MEETING_POLICY to keep it off)"];
  if (typeof n.enabled !== "boolean") problems.push("native.enabled must be true or false");
  if (typeof n.watchHours !== "number" || !Number.isInteger(n.watchHours) || n.watchHours < 1 || n.watchHours > 72) problems.push("native.watchHours must be an integer from 1 to 72");
  const why = (v: unknown, at: string): void => {
    if (typeof v !== "string" || v.trim().length === 0) problems.push(`${at}: say why this deployment reads the org's meeting transcripts`);
  };
  const ref = (v: unknown, at: string): void => {
    const refusal = typeof v === "string" ? secretNameRefusal(v) : "a secret name is required";
    if (refusal !== undefined) problems.push(`${at} must name a stored secret (oe secret set <name>): ${refusal}`);
  };
  if (n.teams !== undefined) {
    const t = n.teams;
    if (!Array.isArray(t.tenants) || t.tenants.length === 0) problems.push("native.teams.tenants must list the org's own tenant ids");
    else for (const id of t.tenants) if (!GUID.test(id)) problems.push(`native.teams.tenants: "${id}" is not a lowercase tenant GUID`);
    if (typeof t.clientId !== "string" || !GUID.test(t.clientId)) problems.push("native.teams.clientId must be the app registration's lowercase application (client) id");
    ref(t.clientSecretRef, "native.teams.clientSecretRef");
    why(t.why, "native.teams");
  }
  if (n.meet !== undefined) {
    const m = n.meet;
    if (!Array.isArray(m.domains) || m.domains.length === 0) problems.push("native.meet.domains must list the org's own Workspace domains");
    else for (const d of m.domains) if (typeof d !== "string" || !DOMAIN.test(d)) problems.push(`native.meet.domains: "${String(d)}" is not a lowercase domain`);
    ref(m.serviceAccountKeyRef, "native.meet.serviceAccountKeyRef");
    why(m.why, "native.meet");
  }
  if (n.zoom !== undefined) {
    const z = n.zoom;
    if (typeof z.accountId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(z.accountId)) problems.push("native.zoom.accountId must be the Zoom account id");
    if (typeof z.clientId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(z.clientId)) problems.push("native.zoom.clientId must be the Server-to-Server OAuth app's client id");
    ref(z.clientSecretRef, "native.zoom.clientSecretRef");
    why(z.why, "native.zoom");
  }
  if (n.enabled === true && n.teams === undefined && n.meet === undefined && n.zoom === undefined) {
    problems.push("native.enabled with no platform would refuse every recap — declare native.teams, native.meet or native.zoom, or set native.enabled: false");
  }
  return problems;
}

export function defineMeetingPolicy(p: MeetingPolicy): MeetingPolicy {
  const problems = meetingPolicyProblems(p);
  if (problems.length > 0) {
    throw new Error(`meeting policy is unusable — meetings stay OFF (fail closed):\n${problems.map((x) => `  - ${x}`).join("\n")}`);
  }
  return Object.freeze({
    ...p,
    hosts: Object.freeze(p.hosts.map((h) => Object.freeze({ ...h }))),
    retention: Object.freeze({ ...p.retention }),
    box: Object.freeze({ ...p.box }),
    transcription: Object.freeze({ ...p.transcription }),
    native: Object.freeze({
      ...p.native,
      ...(p.native.teams !== undefined ? { teams: Object.freeze({ ...p.native.teams, tenants: Object.freeze([...p.native.teams.tenants]) }) } : {}),
      ...(p.native.meet !== undefined ? { meet: Object.freeze({ ...p.native.meet, domains: Object.freeze([...p.native.meet.domains]) }) } : {}),
      ...(p.native.zoom !== undefined ? { zoom: Object.freeze({ ...p.native.zoom }) } : {}),
    }),
  });
}

const SLOT = processRegistrySlot<MeetingPolicy>("meeting-policy.v1");

export function registerMeetingPolicy(p: MeetingPolicy): void {
  SLOT.set(defineMeetingPolicy(p));
}

export function meetingPolicy(): MeetingPolicy {
  return SLOT.get() ?? DEFAULT_MEETING_POLICY;
}

export function setMeetingPolicyForTest(p: MeetingPolicy): void {
  SLOT.set(defineMeetingPolicy(p));
}

export function resetMeetingPolicyForTest(): void {
  SLOT.set(null);
}

function matchMeetingHost(policy: MeetingPolicy, link: ParsedMeetingLink): { readonly rule: MeetingHostRule } | { readonly refusal: string } {
  const rule = policy.hosts.find((h) => h.platform === link.platform && h.host === link.host);
  if (rule === undefined) {
    return { refusal: `this deployment does not join ${platformLabel(link.platform)} meetings on ${link.host} — an admin adds the host to agent/meetings/policy.ts in a pull request` };
  }
  if (link.platform === "teams") {
    if (link.tenantId === undefined) {
      return { refusal: "that Teams link does not name its organiser's tenant, so I can't confirm it is one of this organisation's meetings. Paste the full \"Join the meeting now\" link from the invite" };
    }
    if (!(rule.tenants ?? []).includes(link.tenantId)) {
      return { refusal: "that Teams meeting belongs to an organisation outside the tenants this deployment may join, so I won't join it (external meetings are refused)" };
    }
  }
  if (link.platform === "discord" && (link.guildId === undefined || !(rule.guilds ?? []).includes(link.guildId))) {
    return { refusal: "that Discord voice channel is on a server this deployment may not join — an admin adds the server id to the Discord rule in agent/meetings/policy.ts" };
  }
  return { rule };
}

export function meetingJoinRefusal(
  policy: MeetingPolicy,
  link: ParsedMeetingLink,
  ask: { readonly trust: Trust; readonly nonMember: boolean; readonly actingPrincipal: string | undefined },
): string | undefined {
  if (!policy.enabled) return "meetings are not enabled on this deployment — an admin turns them on in agent/meetings/policy.ts";
  if (ask.trust !== "internal") {
    return "this conversation is not confirmed internal (a shared channel, a guest or an outside account), and a meeting bot records everyone in the room — so I won't join a meeting from here. Ask from an internal channel or DM";
  }
  if (ask.nonMember) return "a message from someone outside the workspace woke this turn, so I won't send a meeting bot from it";
  // principal-gate: presence — a bot that records a meeting goes in a real person's name, and a triggered fire has nobody here to own the ask or admit the bot.
  if (ask.actingPrincipal === undefined) return "joining a meeting needs a person in the conversation — a triggered routine fire has nobody to ask on behalf of";
  const match = matchMeetingHost(policy, link);
  if ("refusal" in match) return match.refusal;
  return undefined;
}

export function meetingLeaveRefusal(ask: { readonly trust: Trust; readonly nonMember: boolean; readonly actingPrincipal: string | undefined }): string | undefined {
  if (ask.trust !== "internal") return "this conversation is not confirmed internal, so I can't stop a meeting bot from here — ask from the internal channel or DM that sent it";
  if (ask.nonMember) return "a message from someone outside the workspace woke this turn, so I won't act on a meeting bot from it";
  // principal-gate: presence — stopping a recorder is done in a real person's name, and a triggered fire has nobody here to ask it.
  if (ask.actingPrincipal === undefined) return "stopping a meeting bot needs a person in the conversation — a triggered routine fire has nobody to ask on behalf of";
  return undefined;
}

export function normaliseOrganiserEmail(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at <= 0 || !/^[a-z0-9._%+-]+$/.test(v.slice(0, at)) || !DOMAIN.test(v.slice(at + 1))) return undefined;
  return v;
}

export function nativeRecapRefusal(
  policy: MeetingPolicy,
  link: ParsedMeetingLink,
  ask: { readonly trust: Trust; readonly nonMember: boolean; readonly actingPrincipal: string | undefined; readonly organiserEmail?: string },
): string | undefined {
  const n = policy.native;
  if (!n.enabled) return "recaps from the meeting platform's own transcript are not enabled on this deployment — an admin turns them on in agent/meetings/policy.ts (native)";
  if (ask.trust !== "internal") {
    return "this conversation is not confirmed internal (a shared channel, a guest or an outside account), and a meeting transcript holds everyone's words — so I won't post a recap here. Ask from an internal channel or DM";
  }
  if (ask.nonMember) return "a message from someone outside the workspace woke this turn, so I won't read a meeting transcript from it";
  // principal-gate: presence — a transcript read with the org's credential is asked in a real person's name, and a triggered fire has nobody here to own it.
  if (ask.actingPrincipal === undefined) return "a meeting recap needs a person in the conversation — a triggered routine fire has nobody to ask on behalf of";
  const label = platformLabel(link.platform);
  const none = `this deployment has no ${label} credential for meeting transcripts — an admin declares native.${link.platform} in agent/meetings/policy.ts`;
  if (link.platform === "teams") {
    if (n.teams === undefined) return none;
    if (link.tenantId === undefined || link.organizerId === undefined) {
      return "that Teams link does not name its organiser, so I can't find the meeting's transcript. Paste the full \"Join the meeting now\" link from the invite";
    }
    if (!n.teams.tenants.includes(link.tenantId)) return "that Teams meeting belongs to an organisation outside this deployment's tenants, so I won't read its transcript";
    return undefined;
  }
  if (link.platform === "meet") {
    if (n.meet === undefined) return none;
    const email = normaliseOrganiserEmail(ask.organiserEmail);
    if (email === undefined) return "a Google Meet link does not name its organiser — tell me the organiser's email address, and I read the transcript as that person";
    if (!n.meet.domains.includes(email.slice(email.lastIndexOf("@") + 1))) return "that organiser is outside this deployment's Google Workspace domains, so I won't read the meeting's transcript";
    return undefined;
  }
  if (link.platform === "discord") return "Discord keeps no transcript of a voice channel, so there is no platform transcript to recap — ask me to join the voice channel instead, and OE's notetaker records it";
  if (n.zoom === undefined) return none;
  return undefined;
}
