import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { TEAMS_APP_NAME_MAX, TEAMS_DEFAULT_APP_NAME, TEAMS_DEPLOY_HOST_PLACEHOLDER } from "./app-manifest.js";

export type TeamsListingRoute = "org" | "store";

export type TeamsChannelFeatures = "omit" | "tier1";

export const TEAMS_PROJECT_MARK_ICON_SHA256: Readonly<Record<"color" | "outline", string>> = {
  color: "7e9ce93dbf0414a6509b6cd8df3b5f1d2fcded333c66f86f3b6b911496106a89",
  outline: "806277cc2dfc1aa870219acc11522145214a591aac55a548660ecfe3b3303646",
};

const TEAMS_STORE_CHANNEL_SCHEMA = "1.25";

const TEAM_SCOPE_RSC = new Set(["ChannelMessage.Read.Group", "ChannelMember.Read.Group"]);

const GUID = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const SEMVER = /^([0-9]|[1-9]+[0-9]*)\.([0-9]|[1-9]+[0-9]*)\.([0-9]|[1-9]+[0-9]*)$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const LIMITS = { nameFull: 100, descriptionShort: 80, descriptionFull: 4000, developerName: 32, mpnId: 10 } as const;

const MICROSOFT_PRODUCT_WORDS = ["Teams", "Microsoft", "Excel", "PowerPoint", "Word", "OneDrive", "SharePoint", "OneNote", "Azure", "Surface", "Xbox"];
const CORE_TEAMS_FEATURE_WORDS = ["Chat", "Contacts", "Calendar", "Calls", "Files", "Activity", "Teams", "Help"];
const PREPRODUCTION_WORDS = ["Beta", "Dev", "Preview", "UAT"];

const FORBIDDEN_VALID_DOMAINS = [
  "azurewebsites.net",
  "azureedge.com",
  "microsoft.com",
  "microsoftonline.com",
  "onmicrosoft.com",
  "go.microsoft.com",
  "teams.microsoft.com",
];

export interface TeamsPackageFinding {
  readonly id: string;
  readonly level: "block" | "warn";
  readonly detail: string;
  readonly fix?: string;
}

export interface TeamsAppPackageInput {
  readonly manifest: string;
  readonly route: TeamsListingRoute;
  readonly appId?: string;
  readonly developerName?: string;
  readonly partnerId?: string;
  readonly version?: string;
  readonly supportContact?: string;
  readonly channelFeatures?: TeamsChannelFeatures;
  readonly policyPages: { readonly privacy: boolean; readonly terms: boolean };
  readonly icons: { readonly color?: Uint8Array; readonly outline?: Uint8Array };
}

export interface TeamsAppPackage {
  readonly findings: readonly TeamsPackageFinding[];
  readonly manifest: string;
  readonly archive?: Uint8Array;
  readonly fileName: string;
}

type Manifest = {
  $schema?: string;
  manifestVersion: string;
  version: string;
  id: string;
  developer: { name: string; mpnId?: string; websiteUrl: string; privacyUrl: string; termsOfUseUrl: string };
  name: { short: string; full: string };
  description: { short: string; full: string };
  accentColor: string;
  bots?: { botId: string; scopes: string[] }[];
  webApplicationInfo?: { id: string; resource?: string };
  authorization?: { permissions?: { resourceSpecific?: { name: string; type: string }[] } };
  validDomains?: string[];
  supportsChannelFeatures?: string;
};

const wordIn = (text: string, words: readonly string[]): string | undefined =>
  words.find((w) => new RegExp(`(^|[^A-Za-z0-9])${w}($|[^A-Za-z0-9])`, "i").test(text));

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "teams-app" : s;
}

function isSupportContact(raw: string): boolean {
  const v = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^https:\/\/[^\s]+$/i.test(v);
}

export function buildTeamsAppPackage(input: TeamsAppPackageInput): TeamsAppPackage {
  const findings: TeamsPackageFinding[] = [];
  const block = (id: string, detail: string, fix?: string) => findings.push({ id, level: "block", detail, ...(fix ? { fix } : {}) });
  const warn = (id: string, detail: string, fix?: string) => findings.push({ id, level: "warn", detail, ...(fix ? { fix } : {}) });
  const store = input.route === "store";

  const appId = input.appId?.trim() ?? "";
  const developerName = input.developerName?.trim() ?? "";
  const m = JSON.parse(
    input.manifest
      .split("{{MICROSOFT_APP_ID}}")
      .join(appId === "" ? "{{MICROSOFT_APP_ID}}" : JSON.stringify(appId).slice(1, -1))
      .split("{{DEVELOPER_NAME}}")
      .join(developerName === "" ? "{{DEVELOPER_NAME}}" : JSON.stringify(developerName).slice(1, -1)),
  ) as Manifest;

  if (input.version !== undefined) m.version = input.version.trim();
  const partnerId = input.partnerId?.trim();
  if (partnerId) m.developer = { ...m.developer, mpnId: partnerId };

  if (store) {
    if (input.channelFeatures === "tier1") {
      m.$schema = `https://developer.microsoft.com/en-us/json-schemas/teams/v${TEAMS_STORE_CHANNEL_SCHEMA}/MicrosoftTeams.schema.json`;
      m.manifestVersion = TEAMS_STORE_CHANNEL_SCHEMA;
      m.supportsChannelFeatures = "tier1";
      warn(
        "store-channel-tier1",
        "the package declares supportsChannelFeatures \"tier1\", so a team can install the agent in shared and private channels. " +
          "The agent maps every channel that is not confirmed team-wide to a private surface, but its behaviour in a shared " +
          "channel with external members has not been tested on a live tenant.",
        "test a shared and a private channel on your own tenant before you submit — docs/deploy/surfaces/teams.md § Listing in the Teams admin centre",
      );
    } else if (input.channelFeatures === "omit") {
      for (const bot of m.bots ?? []) bot.scopes = bot.scopes.filter((s) => s !== "team");
      const rsc = m.authorization?.permissions?.resourceSpecific;
      if (rsc) m.authorization = { permissions: { resourceSpecific: rsc.filter((p) => !TEAM_SCOPE_RSC.has(p.name)) } };
    } else {
      block(
        "store-channel-choice",
        "a store package with the team (channel) scope must use manifest schema 1.25 and declare supportsChannelFeatures \"tier1\" " +
          "(Teams Store validation guidelines, from July 2026). That flag also opens shared and private channels.",
        "pass channelFeatures \"tier1\" to keep channels, or \"omit\" to list the agent for 1:1 and group chats only",
      );
    }
  }

  if (store) {
    const contact = input.supportContact?.trim() ?? "";
    if (contact === "") {
      block(
        "store-report-contact",
        "a store app with AI-generated content must give users a way to report harmful content (store guideline \"Apps with AI-generated content\").",
        "pass supportContact: an email address or an https URL that a person reads",
      );
    } else if (!isSupportContact(contact)) {
      block("store-report-contact", "supportContact is not an email address or an https URL.", "pass a monitored email address or an https URL");
    } else {
      m.description = { ...m.description, full: `${m.description.full} To report a harmful or offensive reply, contact ${contact}.` };
    }
    if (!/\bAI\b/.test(m.description.full)) {
      block("store-ai-disclosure", "description.full does not say that the app uses AI (store guideline \"Apps with AI-generated content\").");
    }
  }

  const filled = JSON.stringify(m, null, 2);
  if (filled.includes("{{MICROSOFT_APP_ID}}")) {
    block("app-id", "the Azure Bot's application id is not set, so the package still carries {{MICROSOFT_APP_ID}}.", "set the teams.appId setting in agent/settings/settings.ts");
  }
  if (filled.includes("{{DEVELOPER_NAME}}")) block("developer-name", "the developer name is empty.", "pass developerName: your organisation's name");
  if (filled.includes(TEAMS_DEPLOY_HOST_PLACEHOLDER)) block("host", "the package still carries the deploy-host placeholder.", "pass baseUrl: this deployment's public origin");

  if (appId !== "" && !GUID.test(appId)) block("app-id", "the teams.appId setting is not a GUID (manifest schema: id).");
  const bot = m.bots?.[0];
  if (bot && bot.botId !== m.id) block("bot-id", "bots[0].botId differs from id.");
  if (m.webApplicationInfo && m.webApplicationInfo.id !== m.id) block("web-application-info", "webApplicationInfo.id differs from id.");
  if (!SEMVER.test(m.version)) block("version", `version "${m.version}" is not MAJOR.MINOR.PATCH (manifest schema).`);
  if (m.name.short.length > TEAMS_APP_NAME_MAX) block("name", `name.short is ${m.name.short.length} characters; the schema allows ${TEAMS_APP_NAME_MAX}.`);
  if (m.name.full.length > LIMITS.nameFull) block("name", `name.full is ${m.name.full.length} characters; the schema allows ${LIMITS.nameFull}.`);
  if (m.description.short.length > LIMITS.descriptionShort) block("description", `description.short is longer than ${LIMITS.descriptionShort} characters.`);
  if (m.description.full.length > LIMITS.descriptionFull) block("description", `description.full is longer than ${LIMITS.descriptionFull} characters.`);
  if (developerName.length > LIMITS.developerName) {
    block("developer-name", `the developer name is ${developerName.length} characters; the schema allows ${LIMITS.developerName}.`);
  }
  if (partnerId !== undefined && partnerId !== "" && !new RegExp(`^[0-9]{1,${LIMITS.mpnId}}$`).test(partnerId)) {
    block("partner-id", `partnerId must be digits, at most ${LIMITS.mpnId} (manifest schema: developer.mpnId).`);
  }
  if (!HEX_COLOR.test(m.accentColor)) block("accent-color", "accentColor is not a #RRGGBB colour.");
  for (const [field, url] of Object.entries({ websiteUrl: m.developer.websiteUrl, privacyUrl: m.developer.privacyUrl, termsOfUseUrl: m.developer.termsOfUseUrl })) {
    if (!/^https:\/\//i.test(url)) block("developer-url", `developer.${field} is not an https URL.`);
  }

  const name = m.name.short;
  if (wordIn(name, [TEAMS_DEFAULT_APP_NAME.replace(/ /g, "[^A-Za-z0-9]*")])) {
    block(
      "name-brand",
      `the app name "${name}" is the project's name. A listing names your agent, not the project.`,
      "set identity.name in agent/settings/settings.ts, or pass appName",
    );
  }
  const product = wordIn(name, MICROSOFT_PRODUCT_WORDS);
  if (product) {
    (store ? block : warn)("name-microsoft", `the app name contains "${product}". The store refuses a Microsoft product name in an app name.`, "choose a name without it");
  }
  const lead = CORE_TEAMS_FEATURE_WORDS.find((w) => new RegExp(`^${w}($|[^A-Za-z0-9])`, "i").test(name));
  if (lead) (store ? block : warn)("name-lead", `the app name leads with "${lead}", a core Teams feature. The store refuses that.`);
  const pre = wordIn(name, PREPRODUCTION_WORDS);
  if (pre) (store ? block : warn)("name-preproduction", `the app name contains "${pre}". The store accepts production manifests only.`);

  for (const d of m.validDomains ?? []) {
    const lower = d.toLowerCase();
    if (/[/:]/.test(d.replace(/:\d+$/, "")) || /^https?/i.test(d)) block("valid-domains", `validDomains holds "${d}", which is not a bare domain.`);
    if (d.includes("*")) (store ? block : warn)("valid-domains", `validDomains holds the wildcard "${d}".`);
    const bad = FORBIDDEN_VALID_DOMAINS.find((f) => lower === f || lower.endsWith(`.${f}`));
    if (bad) {
      (store ? block : warn)(
        "valid-domains",
        `validDomains holds "${d}", under ${bad}, which the store refuses.`,
        "serve the deployment on a domain your organisation controls",
      );
    }
    if (lower === "localhost" || lower.startsWith("localhost:") || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(lower)) {
      block("valid-domains", `validDomains holds "${d}", which no tenant can reach.`, "pass the deployment's public origin as baseUrl");
    }
  }

  for (const kind of ["privacy", "terms"] as const) {
    if (!input.policyPages[kind]) {
      (store ? block : warn)(
        `policy-${kind}`,
        `policyPages.${kind} is not declared, so /${kind} serves the "not published yet" page. An admin or a store reviewer reads it.`,
        `declare policyPages.${kind} in agent/settings/settings.ts and deploy before you upload`,
      );
    }
  }

  if (store && !partnerId) {
    warn(
      "partner-id",
      "developer.mpnId is not set. The store guidelines recommend it, and publisher attestation needs a verified partner account.",
      "pass partnerId: your Microsoft AI Cloud Partner Program ID",
    );
  }

  checkIcon("color", input.icons.color, 192, store, findings);
  checkIcon("outline", input.icons.outline, 32, store, findings);

  const fileName = `${slug(name)}-teams-${m.version}.zip`;
  if (findings.some((f) => f.level === "block")) return { findings, manifest: filled, fileName };
  const archive = zipStored([
    { name: "manifest.json", data: new TextEncoder().encode(filled) },
    { name: "color.png", data: input.icons.color! },
    { name: "outline.png", data: input.icons.outline! },
  ]);
  return { findings, manifest: filled, archive, fileName };
}

function checkIcon(kind: "color" | "outline", bytes: Uint8Array | undefined, size: number, store: boolean, findings: TeamsPackageFinding[]): void {
  const block = (detail: string, fix?: string) => findings.push({ id: `icon-${kind}`, level: "block", detail, ...(fix ? { fix } : {}) });
  if (bytes === undefined) {
    block(`${kind}.png is missing.`, `pass the path of your ${size}x${size} PNG as icons.${kind}`);
    return;
  }
  if (createHash("sha256").update(bytes).digest("hex") === TEAMS_PROJECT_MARK_ICON_SHA256[kind]) {
    const detail = `${kind}.png is the shipped project-mark file. A store listing shows your agent's own icon.`;
    const fix = `replace it with your own ${size}x${size} PNG`;
    if (store) {
      block(detail, fix);
      return;
    }
    findings.push({ id: `icon-${kind}`, level: "warn", detail, fix });
  }
  let png: DecodedPng;
  try {
    png = decodePng(bytes);
  } catch (err) {
    block(`${kind}.png cannot be read: ${err instanceof Error ? err.message : String(err)}.`, "export it as an 8-bit, non-interlaced PNG");
    return;
  }
  if (png.width !== size || png.height !== size) {
    block(`${kind}.png is ${png.width}x${png.height}; Teams needs ${size}x${size}.`);
    return;
  }
  if (kind === "outline") {
    let transparent = 0;
    let white = 0;
    let other = 0;
    for (let i = 0; i < png.rgba.length; i += 4) {
      const a = png.rgba[i + 3]!;
      if (a === 0) transparent++;
      else if (png.rgba[i]! >= 0xf0 && png.rgba[i + 1]! >= 0xf0 && png.rgba[i + 2]! >= 0xf0) white++;
      else other++;
    }
    if (other > 0 || transparent === 0 || white === 0) {
      block(
        `outline.png must be white on a transparent background (${white} white, ${transparent} transparent, ${other} other pixels).`,
        "draw the glyph in white (#FFFFFF) on a fully transparent background",
      );
    }
  }
}

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || PNG_SIGNATURE.some((b, i) => buf[i] !== b)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`bit depth ${data[8]} (only 8 is read)`);
      if (data[12] !== 0) throw new Error("interlaced");
      colourType = data[9]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType];
  if (channels === undefined) throw new Error(`colour type ${colourType}`);
  if (colourType === 3 && palette === undefined) throw new Error("palette image without PLTE");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated image data");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels]! : 0;
      let v = row[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filter ${filter}`);
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    let r: number, g: number, b: number, alpha: number;
    if (colourType === 0) {
      r = g = b = s[0]!;
      alpha = trns && trns.length >= 2 && trns.readUInt16BE(0) === s[0] ? 0 : 255;
    } else if (colourType === 2) {
      [r, g, b] = [s[0]!, s[1]!, s[2]!];
      alpha = trns && trns.length >= 6 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b ? 0 : 255;
    } else if (colourType === 3) {
      const idx = s[0]!;
      [r, g, b] = [palette![idx * 3] ?? 0, palette![idx * 3 + 1] ?? 0, palette![idx * 3 + 2] ?? 0];
      alpha = trns && idx < trns.length ? trns[idx]! : 255;
    } else if (colourType === 4) {
      r = g = b = s[0]!;
      alpha = s[1]!;
    } else {
      [r, g, b, alpha] = [s[0]!, s[1]!, s[2]!, s[3]!];
    }
    rgba.set([r, g, b, alpha], i * 4);
  }
  return { width, height, rgba };
}

function zipStored(entries: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(Buffer.concat([central, name]));
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

export const TEAMS_LISTING_STEPS: Readonly<Record<TeamsListingRoute, readonly string[]>> = {
  org: [
    "Open the Teams admin centre: https://admin.teams.microsoft.com → Teams apps → Manage apps → Upload new app, and pick the zip.",
    "Open the app's Permissions tab and grant org-wide consent if your policy needs it. The RSC grants are consented per team or chat at install.",
    "Allow the app in an app permission policy and, if you want it pinned, an app setup policy.",
    "Install it in one team and one group chat, and @mention it in each to prove the round trip.",
  ],
  store: [
    "Mark the bot's Entra app registration publisher verified (Entra → App registrations → Branding & properties → Publisher verification). The store requires it.",
    "Make the Azure Bot resource's display name, icon, privacy URL and terms URL match the manifest. The reviewer compares them.",
    "Upload the zip in Partner Center → Marketplace offers → Microsoft 365 and Copilot → your Teams app offer → Packages.",
    "Use the same app name, developer name, short description and long description in Partner Center as the manifest carries.",
    "Give the reviewer a test tenant, test accounts and the testing notes from docs/deploy/surfaces/teams.md § Listing in the Teams admin centre.",
    "After the app is live, complete publisher attestation in Partner Center (Microsoft 365 App Compliance). A new app cannot attest before it is listed.",
  ],
};
