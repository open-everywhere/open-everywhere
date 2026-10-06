import { surfaceDisplayName } from "../instructions/seat-prompt.js";
import { accessView } from "../control/views.js";
import { getConfig } from "../access/config.js";
import { displayTitle } from "../identity/display-title.js";
import { domainContainers, domainRoster, type Domain } from "../memory/domain.js";

export interface WideningSubject {
  readonly label: string;
  readonly reachTags: readonly string[];
  readonly opaqueSources: readonly string[];
}

export interface DomainExposureInput {
  readonly org: string;
  readonly domain: string | null;
  readonly subject: WideningSubject;
  readonly landsOnARoom?: boolean;
  readonly reachOf?: (surfaceKey: string) => Promise<readonly string[]>;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function joinWords(words: readonly string[]): string {
  const kept = words.filter((w) => w.trim().length > 0);
  if (kept.length === 0) return "";
  if (kept.length === 1) return kept[0];
  return `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
}

function surfaceSentence(platforms: readonly string[]): string {
  return joinWords(platforms.map((p) => surfaceDisplayName(p)));
}

function roomCount(n: number): string {
  return n === 1 ? "1 room" : `${n} rooms`;
}

async function reachTagsOf(surfaceKey: string): Promise<readonly string[]> {
  const parts = surfaceKey.split("/");
  const a = await accessView({ platform: parts[0] ?? "", workspace: parts[1] ?? "", channel: parts.slice(2).join("/"), mode: "channel" });
  return [
    ...a.reachableHosts.map((h) => `host:${normalizeHost(h.host)}`),
    ...a.connectors.map((c) => `connector:${c}`),
    ...a.repos.map((r) => `repo:${r}`),
    ...a.skills.map((s) => `skill:${s}`),
    ...a.subagents.map((s) => `subagent:${s}`),
  ];
}

function domainLabel(d: Domain | undefined, name: string): string {
  return displayTitle(d) ?? name;
}

function enumerableRooms(d: Domain): readonly string[] {
  return domainRoster(d);
}

function claimSentence(d: Domain): string | undefined {
  const entries = domainContainers(d).filter((c) => c.trim().length > 0);
  if (entries.length === 0) return undefined;
  const grains = new Set(
    entries.map((e) => {
      const where = surfaceDisplayName(e.split("/")[0] ?? "");
      const scope = e.split("/").length <= 2 ? "every room in a whole workspace" : "every room matching a pattern";
      return where ? `${scope} on ${where}` : scope;
    }),
  );
  return joinWords([...grains].sort());
}

function opaqueSentence(sources: readonly string[]): string {
  const named = sources.filter((s) => s.trim().length > 0);
  if (named.length === 0) {
    return "The agent cannot list who else can read the source itself. Check that where the source lives.";
  }
  return `The agent cannot list who else can read ${joinWords(named)}. Check that there before you send.`;
}

export async function domainExposureLines(input: DomainExposureInput): Promise<readonly string[]> {
  const opaque = opaqueSentence(input.subject.opaqueSources);

  if (input.landsOnARoom === false) return [opaque];

  if (!input.domain) {
    return ["This room is in no memory domain, so this reaches this room and no other.", opaque];
  }

  let domain: Domain | undefined;
  let rooms: readonly string[];
  try {
    domain = getConfig()
      .loadDomains()
      .find((d) => d.name === input.domain);
    if (!domain) throw new Error("domain not loaded");
    rooms = enumerableRooms(domain);
  } catch {
    return [`The agent could not read the rooms of the "${input.domain}" domain, so it cannot show what this would expose.`, opaque];
  }

  const label = domainLabel(domain, input.domain);
  const lines: string[] = [];
  const sharesMemory = domain.memory !== undefined;

  const claims = claimSentence(domain);

  if (rooms.length === 0) {
    lines.push(
      claims
        ? `The "${label}" domain lists no rooms — it admits ${claims} by a rule — so the agent cannot show how far this reaches inside it.`
        : `The "${label}" domain does not list its rooms, so the agent cannot show how far this reaches inside it.`,
    );
    if (sharesMemory) lines.push("Every room it admits shares one memory, so what the agent reads through this can come back in any of them.");
    lines.push(opaque);
    return lines;
  }

  const platforms = [...new Set(rooms.map((r) => r.split("/")[0] ?? ""))].sort();
  const where = surfaceSentence(platforms);
  lines.push(`This lands in the "${label}" domain, which lists ${roomCount(rooms.length)}${where ? ` on ${where}` : ""}.`);
  if (claims) lines.push(`It also admits ${claims} by a rule, and the agent cannot name those rooms — so the count above is a floor.`);

  if (sharesMemory) {
    lines.push("Those rooms share one memory, so what the agent reads through this can come back in any of them.");
  }

  if (input.subject.reachTags.length > 0) {
    const wanted = new Set(input.subject.reachTags);
    let holders = 0;
    try {
      const reach = input.reachOf ?? reachTagsOf;
      for (const room of rooms) {
        const held = await reach(room);
        if (held.some((t) => wanted.has(t))) holders++;
      }
      lines.push(
        holders === 0
          ? claims
            ? `No room this domain LISTS can reach ${input.subject.label} today. The rooms its rule admits were not checked.`
            : `No room in this domain can reach ${input.subject.label} today, so this widens the domain itself.`
          : claims
            ? `${holders} of the rooms it lists can already reach ${input.subject.label}.`
            : `${roomCount(holders)} in this domain can already reach ${input.subject.label}.`,
      );
    } catch {
      lines.push(`The agent could not check which rooms already reach ${input.subject.label}.`);
    }
  }

  lines.push(opaque);
  return lines;
}
