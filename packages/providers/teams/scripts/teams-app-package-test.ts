import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { getSettings, overrideSettingsForTest, surfaceAppPackageSource } from "@open-everywhere/core/agent/adapter-api.js";
import { teamsAppManifestTemplate } from "../agent/app-manifest.js";
import { buildTeamsAppPackage, decodePng, TEAMS_PROJECT_MARK_ICON_SHA256, type TeamsAppPackageInput } from "../agent/app-package.js";
import { registerTeamsOps } from "../agent/ops.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const APP_ID = "11111111-2222-3333-4444-555555555555";
const HOST = "agent.acme.example";

function png(size: number, px: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) rows.push(...px(x, y));
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.from(rows))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const COLOR = png(192, (x, y) => (x > 40 && x < 150 && y > 40 && y < 150 ? [0x20, 0x60, 0xc0, 255] : [0xff, 0xff, 0xff, 255]));
const OUTLINE = png(32, (x, y) => (x > 8 && x < 24 && y > 8 && y < 24 ? [255, 255, 255, 255] : [0, 0, 0, 0]));

const manifestFor = (agentName?: string): string =>
  teamsAppManifestTemplate(agentName === undefined ? {} : { agentName }).split("YOUR-DEPLOY-URL").join(HOST);

const base = (over: Partial<TeamsAppPackageInput> = {}): TeamsAppPackageInput => ({
  manifest: manifestFor("Acme Helper"),
  route: "org",
  appId: APP_ID,
  developerName: "Acme Ltd",
  policyPages: { privacy: true, terms: true },
  icons: { color: COLOR, outline: OUTLINE },
  ...over,
});

const ids = (input: TeamsAppPackageInput, level: "block" | "warn" = "block"): string[] =>
  buildTeamsAppPackage(input)
    .findings.filter((f) => f.level === level)
    .map((f) => f.id);

function unzip(zip: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(zip);
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, "zip: end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "zip: central directory entry");
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, "zip: local header");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    assert.equal(crc32(data), crc, `zip: CRC of ${name}`);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

{
  const built = buildTeamsAppPackage(base());
  ok(built.findings.every((f) => f.level !== "block"), `org: a complete package passes (got ${JSON.stringify(built.findings)})`);
  ok(built.archive !== undefined, "org: the zip is built");
  const files = unzip(built.archive!);
  ok(JSON.stringify([...files.keys()]) === JSON.stringify(["manifest.json", "color.png", "outline.png"]), "zip: exactly the manifest and two icons, flat at the root");
  ok(files.get("color.png")!.equals(Buffer.from(COLOR)) && files.get("outline.png")!.equals(Buffer.from(OUTLINE)), "zip: the icons are the bytes passed in");
  const text = files.get("manifest.json")!.toString("utf8");
  ok(text === built.manifest, "zip: manifest.json is the returned manifest");
  ok(!text.includes("{{") && !text.includes("YOUR-DEPLOY-URL"), "zip: no placeholder is left");
  const m = JSON.parse(text) as { id: string; manifestVersion: string; developer: { name: string }; bots: { botId: string; scopes: string[] }[]; webApplicationInfo: { id: string }; name: { short: string } };
  ok(m.id === APP_ID && m.bots[0]!.botId === APP_ID && m.webApplicationInfo.id === APP_ID, "manifest: the app id fills id, botId and webApplicationInfo.id");
  ok(m.developer.name === "Acme Ltd" && m.name.short === "Acme Helper", "manifest: the developer name and the configured agent name");
  ok(m.manifestVersion === "1.17" && m.bots[0]!.scopes.includes("team"), "org: schema 1.17 with the team scope kept (the 1.25 floor is a store rule)");
  ok(built.fileName === "acme-helper-teams-1.0.4.zip", `the file name comes from the agent name and version (got ${built.fileName})`);
  const again = buildTeamsAppPackage(base());
  ok(Buffer.from(again.archive!).equals(Buffer.from(built.archive!)), "zip: the same inputs give the same bytes");
  const quoted = buildTeamsAppPackage(base({ developerName: 'Acme "Labs"' }));
  ok((JSON.parse(quoted.manifest) as { developer: { name: string } }).developer.name === 'Acme "Labs"', "manifest: a quote in the developer name stays valid JSON");
}

ok(ids(base({ manifest: manifestFor() })).includes("name-brand"), "🔴 no name configured ⇒ the project's name ⇒ refused");
ok(ids(base({ manifest: manifestFor("Open Everywhere Bot") })).includes("name-brand"), "🔴 a name that holds the project's name is refused");
ok(!ids(base()).includes("name-brand"), "…and a configured name passes (negative control)");
{
  const shipped = (f: string) => new Uint8Array(readFileSync(join(REPO_ROOT, "teams-app", f)));
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  ok(hash(shipped("color.png")) === TEAMS_PROJECT_MARK_ICON_SHA256.color, "the pinned colour-mark hash is the tracked teams-app/color.png");
  ok(hash(shipped("outline.png")) === TEAMS_PROJECT_MARK_ICON_SHA256.outline, "the pinned outline-mark hash is the tracked teams-app/outline.png");
  const markIcons = { color: shipped("color.png"), outline: shipped("outline.png") };
  const marked = ids(base({ route: "store", channelFeatures: "omit", supportContact: "abuse@acme.example", icons: markIcons }));
  ok(marked.includes("icon-color") && marked.includes("icon-outline"), "🔴 store: the shipped project-mark files as icons are refused");
  const orgMarked = buildTeamsAppPackage(base({ icons: markIcons }));
  ok(orgMarked.archive !== undefined && orgMarked.findings.some((f) => f.id === "icon-color" && f.level === "warn"), "org: the shipped mark files warn and still build (OPE-2334 default avatar)");
  ok(decodePng(shipped("outline.png")).width === 32, "the decoder reads the shipped outline PNG");
}

ok(ids(base({ appId: undefined })).includes("app-id"), "no app id ⇒ refused");
ok(ids(base({ appId: "not-a-guid" })).includes("app-id"), "an app id that is not a GUID ⇒ refused");
ok(ids(base({ appId: 'a"b\\c' })).includes("app-id"), "an app id holding a quote or backslash is a finding, not a JSON parse crash");
ok(ids(base({ developerName: "" })).includes("developer-name"), "no developer name ⇒ refused");
ok(ids(base({ developerName: "x".repeat(33) })).includes("developer-name"), "a developer name over 32 characters ⇒ refused");
ok(ids(base({ version: "1.0" })).includes("version"), "a version that is not MAJOR.MINOR.PATCH ⇒ refused");
ok(ids(base({ partnerId: "12ab" })).includes("partner-id"), "a partner id that is not digits ⇒ refused");
ok(ids(base({ manifest: teamsAppManifestTemplate({ agentName: "Acme Helper" }) })).includes("host"), "the host placeholder left in ⇒ refused");
ok(ids(base({ icons: { outline: OUTLINE } })).includes("icon-color"), "a missing colour icon ⇒ refused");
ok(ids(base({ icons: { color: png(96, () => [0, 0, 0, 255]), outline: OUTLINE } })).includes("icon-color"), "a colour icon that is not 192x192 ⇒ refused");
ok(ids(base({ icons: { color: COLOR, outline: png(32, () => [255, 255, 255, 255]) } })).includes("icon-outline"), "an outline icon with no transparency ⇒ refused");
ok(ids(base({ icons: { color: COLOR, outline: png(32, (x) => (x < 16 ? [0, 0, 0, 255] : [0, 0, 0, 0])) } })).includes("icon-outline"), "an outline icon with a black glyph ⇒ refused");
ok(ids(base({ icons: { color: COLOR, outline: new Uint8Array([1, 2, 3]) } })).includes("icon-outline"), "an outline file that is not a PNG ⇒ refused");
ok(ids(base({ manifest: manifestFor("Acme").split(HOST).join("localhost:3000") })).includes("valid-domains"), "a localhost host ⇒ refused");
ok(buildTeamsAppPackage(base({ manifest: manifestFor() })).archive === undefined, "a blocked package builds no zip");

ok(ids(base({ policyPages: { privacy: false, terms: true } }), "warn").includes("policy-privacy"), "org: an undeclared privacy policy warns");
ok(!ids(base({ policyPages: { privacy: false, terms: true } })).includes("policy-privacy"), "org: …and does not block");
ok(ids(base({ manifest: manifestFor("Teams Helper") }), "warn").includes("name-microsoft"), "org: a Microsoft product name in the app name warns");

const store = (over: Partial<TeamsAppPackageInput> = {}) =>
  base({ route: "store", channelFeatures: "omit", supportContact: "abuse@acme.example", partnerId: "1234567", ...over });
{
  const built = buildTeamsAppPackage(store());
  ok(built.archive !== undefined, `store: a complete package passes (got ${JSON.stringify(built.findings)})`);
  const m = JSON.parse(built.manifest) as {
    manifestVersion: string;
    developer: { mpnId?: string };
    description: { full: string };
    bots: { scopes: string[] }[];
    authorization: { permissions: { resourceSpecific: { name: string }[] } };
  };
  ok(!m.bots[0]!.scopes.includes("team") && m.bots[0]!.scopes.includes("groupChat") && m.bots[0]!.scopes.includes("personal"), "store omit: the team scope is dropped, chats kept");
  const rsc = m.authorization.permissions.resourceSpecific.map((p) => p.name);
  ok(JSON.stringify(rsc) === JSON.stringify(["ChatMessage.Read.Chat"]), `store omit: only the chat RSC grant is left (got ${rsc.join(", ")})`);
  ok(m.manifestVersion === "1.17", "store omit: a package with no channel scope stays on schema 1.17");
  ok(m.developer.mpnId === "1234567", "store: the partner id fills developer.mpnId");
  ok(m.description.full.endsWith("To report a harmful or offensive reply, contact abuse@acme.example."), "store: the report contact is added to the description");
  ok(/\bAI\b/.test(m.description.full) && m.description.full.includes("Microsoft Teams"), "store: the description says it uses AI and names Microsoft Teams in full");
}
{
  const tier1 = buildTeamsAppPackage(store({ channelFeatures: "tier1" }));
  const m = JSON.parse(tier1.manifest) as { $schema: string; manifestVersion: string; supportsChannelFeatures?: string; bots: { scopes: string[] }[] };
  ok(tier1.archive !== undefined, "store tier1: the package passes");
  ok(m.manifestVersion === "1.25" && m.$schema.includes("/v1.25/") && m.supportsChannelFeatures === "tier1", "store tier1: schema 1.25 with supportsChannelFeatures tier1");
  ok(m.bots[0]!.scopes.includes("team"), "store tier1: the team scope is kept");
  ok(tier1.findings.some((f) => f.id === "store-channel-tier1" && f.level === "warn"), "store tier1: the untested shared-channel posture is warned");
}
ok(ids(store({ channelFeatures: undefined })).includes("store-channel-choice"), "🔴 store: no channel choice ⇒ refused (a 1.17 channel app fails store validation)");
ok(ids(store({ supportContact: undefined })).includes("store-report-contact"), "store: no report contact ⇒ refused");
ok(
  ids(store({ manifest: manifestFor("Acme Helper").replace(/ It uses AI to write its replies[^"]*/, "") })).includes("store-ai-disclosure"),
  "store: a description with no AI disclosure ⇒ refused",
);
ok(ids(store({ supportContact: "call us" })).includes("store-report-contact"), "store: a report contact that is neither email nor https ⇒ refused");
ok(ids(store({ policyPages: { privacy: true, terms: false } })).includes("policy-terms"), "store: undeclared terms ⇒ refused");
ok(ids(store({ manifest: manifestFor("Teams Helper") })).includes("name-microsoft"), "store: a Microsoft product name ⇒ refused");
ok(ids(store({ manifest: manifestFor("Chat Buddy") })).includes("name-lead"), "store: a name that leads with a core Teams feature ⇒ refused");
ok(ids(store({ manifest: manifestFor("Acme Helper Beta") })).includes("name-preproduction"), "store: a preproduction word ⇒ refused");
ok(!ids(store({ manifest: manifestFor("Wordsmith") })).includes("name-microsoft"), "store: a word that only contains a product name passes (negative control)");
ok(ids(store({ manifest: manifestFor("Acme").split(HOST).join("acme.azurewebsites.net") })).includes("valid-domains"), "store: an azurewebsites.net host ⇒ refused");
ok(ids(store({ partnerId: undefined }), "warn").includes("partner-id"), "store: no partner id warns");

registerTeamsOps();
{
  const source = surfaceAppPackageSource("teams");
  ok(source !== undefined, "🔴 registerTeamsOps() registers the Teams package builder");
  ok(source!.icons.color === "teams-app/color.png" && source!.outDir === "teams-app", "…with the teams-app/ defaults");
  const savedAppId = getSettings().teams.appId;
  const input = { host: HOST, route: "org" as const, developerName: "Acme Ltd", icons: { color: COLOR, outline: OUTLINE }, env: { MICROSOFT_APP_ID: APP_ID } };
  overrideSettingsForTest({ teams: { appId: "" } });
  const envOnly = source!.build({ ...input, appName: "Acme Helper" });
  ok(envOnly.findings.some((f) => f.id === "app-id" && f.level === "block"), "🔴 OPE-2650: env MICROSOFT_APP_ID with the teams.appId setting unset ⇒ the app-id block (env ignored)");
  ok(envOnly.findings.some((f) => f.id === "app-id" && f.fix?.includes("teams.appId") === true), "OPE-2650: …and the fix names the teams.appId setting");
  overrideSettingsForTest({ teams: { appId: APP_ID } });
  const unnamed = source!.build(input);
  ok(unnamed.findings.some((f) => f.id === "name-brand"), "the registered builder renders from the settings: no identity.name ⇒ the brand ⇒ refused");
  const named = source!.build({ ...input, appName: "Acme Helper" });
  ok(named.archive !== undefined, `…and an explicit appName builds (got ${JSON.stringify(named.findings.filter((f) => f.level === "block"))})`);
  ok((JSON.parse(named.manifest) as { id: string }).id === APP_ID, "…with the app id read from the teams.appId setting");
  overrideSettingsForTest({ teams: { appId: savedAppId } });
  ok(named.steps.some((s) => s.includes("admin.teams.microsoft.com")), "…and the org route's steps name the admin centre");
}

console.log(`✓ teams-app-package: ${n} assertions`);
