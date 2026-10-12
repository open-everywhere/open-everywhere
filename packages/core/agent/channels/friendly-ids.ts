import { parseScopeKey } from "../access/scope-key.js";
import { parsePrincipalKey } from "../identity/principal-key.js";

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  github: "GitHub",
  linear: "Linear",
  notion: "Notion",
  "google-chat": "Google Chat",
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

export function placeBesideKey(key: string): string {
  return `${placeWords({ key })} (${key})`;
}

export function channelWords(platform: string, channelId: string, label?: string, venuePlatform: string = platform): string {
  const named = usableLabel(label, channelId);
  if (named !== undefined) return named;
  if (platform === "slack" && /^D/.test(channelId)) return "a direct message";
  if (venuePlatform === platform && rendersMentions(platform) && /^[\w-]+$/.test(channelId)) return `<#${channelId}>`;
  return `a ${platformName(platform)} conversation`;
}

export type FriendlyNameKind = "person" | "channel" | "server";

export interface FriendlyName {
  readonly label: string;
  readonly kind: FriendlyNameKind;
}

export interface FriendlyRenderContext {
  readonly platform?: string;
  readonly surface?: string;
  readonly names?: ReadonlyMap<string, FriendlyName>;
}

const KEY_PLATFORMS = "slack|discord|teams|github|linear|notion|email|unified|oauth";

const SHAPES: ReadonlyArray<readonly [name: string, source: string]> = [
  ["key", String.raw`(?<![\w./@:-])(?:user:)?(?:${KEY_PLATFORMS})\/[A-Za-z0-9](?:[\w.:@/-]*\w)?`],
  ["grant", String.raw`\boe-grant-(?:room|domain)::\S+`],
  ["run", String.raw`\bwrun_[A-Za-z0-9]+`],
  ["meeting", String.raw`\bmtg_[a-z0-9]{8,}`],
  ["wake", String.raw`\bwake-id="[^"\n]*"`],
  ["teamsConversation", String.raw`\b19:[\w-]+@thread\.[a-z0-9]+`],
  ["teamsPerson", String.raw`\b(?:29:[\w-]{8,}|8:orgid:[0-9a-fA-F-]{36})`],
  ["slack", String.raw`(?<![\w/.-])[UWTCDG](?:0[A-Z0-9]{7,11}|(?=(?:[A-Z]*\d){2})[A-Z0-9]{8,12})\b`],
  ["snowflake", String.raw`(?<![\w./:-])\d{17,20}(?!\w|\.\d)`],
  ["guid", String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`],
];

const TOKEN = new RegExp(SHAPES.map(([name, source]) => `(?<${name}>${source})`).join("|"), "g");

const PROTECTED = /```[\s\S]*?```|`[^`\n]+`|<[@#!][^>\s]+>|<[a-z][a-z0-9+.-]*:\/\/[^>|\s]+(?:\|[^>\n]*)?>|(?:https?|slack):\/\/\S+/g;

function targetRendersMentions(ctx: FriendlyRenderContext): boolean {
  return ctx.platform === "slack" || ctx.platform === "discord";
}

function shapeOf(value: string): string | undefined {
  TOKEN.lastIndex = 0;
  const m = TOKEN.exec(value);
  TOKEN.lastIndex = 0;
  if (m === null || m.index !== 0 || m[0].length !== value.length) return undefined;
  return Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0];
}

const USER_PREFIX = "user:";

function isKey(token: string): boolean {
  const body = token.startsWith(USER_PREFIX) ? token.slice(USER_PREFIX.length) : token;
  const parts = body.split("/");
  const [platform, second] = parts;
  if (platform === "email" || platform === "unified" || platform === "oauth") return true;
  if (platform === "github") return (parts.length === 2 && /^\d+$/.test(second ?? "")) || (parts.length === 3 && parts.every((p) => /^[\w.-]+$/.test(p)));
  return second !== undefined && /\d/.test(second);
}

function escapeLabel(label: string, platform: string | undefined): string {
  if (platform === "slack") return label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (platform === "discord") return label.replace(/[<>]/g, "").replace(/([\\*_~`|])/g, "\\$1").replace(/@/g, "@\u200b");
  if (platform === "teams") return label.replace(/[<>]/g, "");
  return label;
}

function nameFor(ctx: FriendlyRenderContext, id: string): FriendlyName | undefined {
  const hit = ctx.names?.get(id);
  if (hit === undefined) return undefined;
  const label = usableLabel(hit.label, id);
  return label === undefined ? undefined : { label: escapeLabel(label, ctx.platform), kind: hit.kind };
}

function renderPerson(ctx: FriendlyRenderContext, platform: string, id: string): string {
  const name = nameFor(ctx, id);
  if (name !== undefined) return name.label;
  return platform === "slack" || platform === "discord" || platform === "teams" ? `someone on ${platformName(platform)}` : "someone";
}

function renderChannel(ctx: FriendlyRenderContext, platform: string, id: string): string {
  if (ctx.platform === platform && targetRendersMentions(ctx) && /^[\w-]+$/.test(id)) return `<#${id}>`;
  return nameFor(ctx, id)?.label ?? `a ${platformName(platform)} channel`;
}

function renderSlackId(ctx: FriendlyRenderContext, id: string): string {
  switch (id[0]) {
    case "U":
    case "W":
      return renderPerson(ctx, "slack", id);
    case "C":
    case "G":
      return renderChannel(ctx, "slack", id);
    case "D":
      return "a direct message";
    case "T":
      return nameFor(ctx, id)?.label ?? "your Slack workspace";
    case "E":
      return nameFor(ctx, id)?.label ?? "your Slack organization";
    default:
      return "a Slack app";
  }
}

function renderSnowflake(ctx: FriendlyRenderContext, id: string): string | undefined {
  const name = nameFor(ctx, id);
  if (name?.kind === "channel") return renderChannel(ctx, "discord", id);
  if (name !== undefined) return name.label;
  return (ctx.surface ?? ctx.platform) === "discord" ? "something on Discord" : undefined;
}

function renderTeamsId(ctx: FriendlyRenderContext, id: string): string {
  const name = nameFor(ctx, id);
  if (name !== undefined) return name.label;
  return /^19:/.test(id) ? "a Microsoft Teams conversation" : "someone on Microsoft Teams";
}

function renderKey(ctx: FriendlyRenderContext, token: string): string {
  const person = token.startsWith(USER_PREFIX);
  const parts = (person ? token.slice(USER_PREFIX.length) : token).split("/");
  const [platform = "", second = "", third] = parts;
  const last = parts[parts.length - 1]!;
  switch (platform) {
    case "slack":
      if (third === undefined) return person ? renderPerson(ctx, "slack", second) : renderSlackId(ctx, second);
      return /^[UW]/.test(last) || person ? renderPerson(ctx, "slack", last) : renderSlackId(ctx, last);
    case "discord":
      if (third !== undefined) return renderChannel(ctx, "discord", last);
      if (person || nameFor(ctx, second)?.kind === "person") return renderPerson(ctx, "discord", second);
      return nameFor(ctx, second)?.label ?? "a Discord server";
    case "teams":
      if (third === undefined) return person ? "someone on Microsoft Teams" : "your Microsoft Teams organization";
      return renderTeamsId(ctx, last);
    case "github":
      if (person || /^\d+$/.test(last)) return "someone on GitHub";
      return parts.slice(1).join("/");
    case "email":
      return person || parts.length === 2 ? "someone" : "an email inbox";
    case "linear":
    case "notion":
      if (person) return "someone";
      return third === undefined ? `your ${platformName(platform)} workspace` : `a ${platformName(platform)} conversation`;
    default:
      return "another conversation";
  }
}

function renderToken(ctx: FriendlyRenderContext, shape: string, token: string): string | undefined {
  switch (shape) {
    case "key":
      return isKey(token) ? renderKey(ctx, token) : undefined;
    case "grant":
      return "another conversation";
    case "run":
      return "a session";
    case "meeting":
      return "the meeting";
    case "wake":
      return "";
    case "teamsConversation":
    case "teamsPerson":
      return renderTeamsId(ctx, token);
    case "slack":
      return renderSlackId(ctx, token);
    case "snowflake":
      return renderSnowflake(ctx, token);
    case "guid":
      return nameFor(ctx, token)?.label;
    default:
      return undefined;
  }
}

function mentionOf(span: string): { readonly sigil: "@" | "#" | "@&"; readonly id: string } | undefined {
  const m = /^<([@#])([!&])?([^>\s|]+)(?:\|[^>]*)?>$/.exec(span);
  if (m === null) return undefined;
  return { sigil: m[2] === "&" ? "@&" : (m[1] as "@" | "#"), id: m[3]! };
}

const SLACK_ID = /^[UWTCDG](?:0[A-Z0-9]{7,11}|(?=(?:[A-Z]*\d){2})[A-Z0-9]{8,12})$/;

function nativeMention(ctx: FriendlyRenderContext, mention: { readonly id: string }): boolean {
  if (ctx.platform === "slack") return !/^\d{17,20}$/.test(mention.id);
  if (ctx.platform === "discord") return !SLACK_ID.test(mention.id);
  return false;
}

function renderForeignMention(ctx: FriendlyRenderContext, mention: { readonly sigil: "@" | "#" | "@&"; readonly id: string }): string {
  const platform = /^\d{17,20}$/.test(mention.id) ? "discord" : /^[UWCGDT][A-Z0-9_]+$/.test(mention.id) ? "slack" : undefined;
  if (mention.sigil === "@&") return "a Discord role";
  if (mention.sigil === "#") return platform ? renderChannel(ctx, platform, mention.id) : "a channel";
  return platform ? renderPerson(ctx, platform, mention.id) : "someone";
}

function quotedId(span: string): { readonly shape: string; readonly inner: string } | undefined {
  if (!/^`[^`\n]+`$/.test(span)) return undefined;
  const inner = span.slice(1, -1);
  const shape = shapeOf(inner);
  return shape === undefined ? undefined : { shape, inner };
}

function walk(text: string, free: (segment: string) => string, span: (whole: string) => string): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(PROTECTED)) {
    const whole = m[0];
    out += free(text.slice(at, m.index));
    out += span(whole);
    at = m.index + whole.length;
  }
  return out + free(text.slice(at));
}

function tokensIn(segment: string): Array<{ readonly shape: string; readonly token: string; readonly index: number }> {
  const found: Array<{ shape: string; token: string; index: number }> = [];
  for (const m of segment.matchAll(TOKEN)) {
    const shape = Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0];
    if (shape !== undefined) found.push({ shape, token: m[0], index: m.index });
  }
  return found;
}

export function renderFriendlyText(text: string, ctx: FriendlyRenderContext = {}): string {
  if (text.length === 0) return text;
  return walk(
    text,
    (segment) => {
      let out = "";
      let at = 0;
      for (const { shape, token, index } of tokensIn(segment)) {
        const rendered = renderToken(ctx, shape, token);
        if (rendered === undefined) continue;
        const before = segment.slice(at, index);
        const labelled = /\S \($/.test(before) && segment[index + token.length] === ")";
        if (labelled) {
          out += before.slice(0, -2);
          at = index + token.length + 1;
          continue;
        }
        out += before + rendered;
        at = index + token.length;
      }
      return out + segment.slice(at);
    },
    (whole) => {
      const mention = mentionOf(whole);
      if (mention !== undefined) return ctx.platform === undefined || nativeMention(ctx, mention) ? whole : renderForeignMention(ctx, mention);
      const quoted = quotedId(whole);
      if (quoted === undefined) return whole;
      return renderToken(ctx, quoted.shape, quoted.inner) ?? whole;
    },
  );
}

function refsOf(shape: string, token: string, platform: string | undefined, add: (platform: string, id: string) => void): void {
  if (shape === "slack" && /^[UWCGT]/.test(token)) add("slack", token);
  else if (shape === "snowflake" && platform === "discord") add("discord", token);
  else if (shape === "teamsConversation" || shape === "teamsPerson") add("teams", token);
  else if (shape === "guid") add(platform !== undefined && platform !== "plain" && platform !== "slack" && platform !== "discord" ? platform : "teams", token);
  else if (shape === "key" && isKey(token)) {
    const parts = token.replace(/^user:/, "").split("/");
    const keyPlatform = parts[0]!;
    const last = parts[parts.length - 1]!;
    if (keyPlatform === "slack") add("slack", last);
    else if (keyPlatform === "discord") add("discord", last);
    else if (keyPlatform === "teams" && parts.length === 3) add("teams", last);
  }
}

export function resolvableIds(text: string, platform?: string): Array<{ readonly platform: string; readonly id: string }> {
  const out = new Map<string, { platform: string; id: string }>();
  const add = (p: string, id: string): void => {
    if (id.length > 0) out.set(`${p}:${id}`, { platform: p, id });
  };
  walk(
    text,
    (segment) => {
      for (const { shape, token } of tokensIn(segment)) refsOf(shape, token, platform, add);
      return segment;
    },
    (whole) => {
      const mention = mentionOf(whole);
      if (mention !== undefined) {
        if (platform !== undefined && !nativeMention({ platform }, mention)) {
          if (/^\d{17,20}$/.test(mention.id)) add("discord", mention.id);
          else if (/^[UWCGT][A-Z0-9_]+$/.test(mention.id)) add("slack", mention.id);
        }
        return whole;
      }
      const quoted = quotedId(whole);
      if (quoted !== undefined) refsOf(quoted.shape, quoted.inner, platform, add);
      return whole;
    },
  );
  return [...out.values()];
}

export function rawIdLeaks(text: string, platform?: string): string[] {
  const found: string[] = [];
  const counts = (shape: string, token: string): boolean => {
    if (shape === "guid" || (shape === "key" && !isKey(token))) return false;
    if (shape === "snowflake") return platform === undefined || platform === "discord";
    return true;
  };
  walk(
    text,
    (segment) => {
      for (const { shape, token } of tokensIn(segment)) if (counts(shape, token)) found.push(token);
      return segment;
    },
    (whole) => {
      const mention = mentionOf(whole);
      if (mention !== undefined) {
        if (platform !== undefined && mention.sigil !== "@&" && !nativeMention({ platform }, mention)) found.push(mention.id);
        return whole;
      }
      const quoted = quotedId(whole);
      if (quoted !== undefined && counts(quoted.shape, quoted.inner)) found.push(quoted.inner);
      return whole;
    },
  );
  return found;
}
