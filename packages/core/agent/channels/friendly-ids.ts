import { parseScopeKey } from "../access/scope-key.js";
import { parsePrincipalKey } from "../identity/principal-key.js";

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  github: "GitHub",
  linear: "Linear",
  notion: "Notion",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

function rendersMentions(platform: string | undefined): boolean {
  return platform === "slack" || platform === "discord";
}

function nativePerson(id: string, platform: string | undefined): { readonly platform: string | undefined; readonly id: string } {
  const parsed = parsePrincipalKey(id);
  if (parsed !== undefined) return { platform: parsed.platform, id: parsed.id };
  const loose = /^([a-z][a-z0-9-]*)\/(?:[^/\s]+\/)?([^/\s]+)$/u.exec(id);
  return loose === null ? { platform, id } : { platform: loose[1], id: loose[2]! };
}

function usableLabel(label: string | undefined, ...ids: readonly string[]): string | undefined {
  const t = label?.trim();
  if (t === undefined || t.length === 0) return undefined;
  if (ids.some((id) => id.length > 0 && t === id)) return undefined;
  return rawIdLeaks(t).length === 0 ? t : undefined;
}

export interface PersonWordsInput {
  readonly id: string;
  readonly platform?: string;
  readonly label?: string;
  readonly reader?: string;
}

export function samePerson(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0 || b.length === 0) return false;
  return nativePerson(a, undefined).id === nativePerson(b, undefined).id;
}

export function personWords(input: PersonWordsInput): string {
  if (samePerson(input.id, input.reader)) return "you";
  const person = nativePerson(input.id, input.platform);
  const label = usableLabel(input.label, input.id, person.id);
  if (label !== undefined) return label;
  if (rendersMentions(person.platform) && /^[\w-]+$/.test(person.id)) return `<@${person.id}>`;
  return "someone";
}

export function requesterWords(id: string, scopeKey: string | undefined): string {
  const parsed = scopeKey === undefined ? undefined : parseScopeKey(scopeKey);
  const platform = parsed !== undefined && (parsed.kind === "surface" || parsed.kind === "tenant" || parsed.kind === "principal") ? parsed.platform : undefined;
  return personWords({ id, ...(platform !== undefined ? { platform } : {}) });
}

export interface PlaceWordsInput {
  readonly key: string;
  readonly label?: string;
}

export function placeWords(input: PlaceWordsInput): string {
  const label = usableLabel(input.label, input.key);
  if (label !== undefined) return label;
  const parsed = parseScopeKey(input.key);
  switch (parsed.kind) {
    case "surface": {
      if (parsed.platform === "slack" && /^D/.test(parsed.surface)) return "a direct message";
      if (rendersMentions(parsed.platform) && /^[\w-]+$/.test(parsed.surface)) return `<#${parsed.surface}>`;
      if (parsed.platform === "github" && /^[\w.-]+$/.test(parsed.workspace) && /^[\w.-]+$/.test(parsed.surface)) return `${parsed.workspace}/${parsed.surface}`;
      return `a ${platformName(parsed.platform)} conversation`;
    }
    case "tenant":
      return `your ${platformName(parsed.platform)} workspace`;
    case "principal":
      return personWords({ id: parsed.id, platform: parsed.platform });
    case "domain":
      return /^[a-z][a-z0-9-]*$/.test(parsed.name) && rawIdLeaks(parsed.name).length === 0 ? `the ${parsed.name} domain` : "another conversation";
    default:
      return "another conversation";
  }
}

const RAW_ID_SHAPES: readonly RegExp[] = [
  /\b(?:slack|discord|teams|github|linear|notion|unified|oauth)\/[A-Za-z0-9](?:[\w.:/-]*\w)?/g,
  /\bwrun_[A-Za-z0-9]+/g,
  /\boe-grant-(?:room|domain)::\S+/g,
  /\buser:[a-z]+\/\S+/g,
  /\b[UWTCDGBE](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g,
];

const RENDERED_SPANS = /<[@#!][^>\s]+>|<https?:\/\/[^>\s]+>|https?:\/\/\S+/g;

export function rawIdLeaks(text: string): string[] {
  let visible = text.replace(RENDERED_SPANS, " ");
  const found: string[] = [];
  for (const shape of RAW_ID_SHAPES) {
    for (const m of visible.matchAll(shape)) found.push(m[0]);
    visible = visible.replace(shape, " ");
  }
  return found;
}
