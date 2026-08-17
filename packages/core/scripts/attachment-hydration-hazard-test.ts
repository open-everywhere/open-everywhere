import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function tsSources(dir: URL): { readonly url: URL; readonly src: string }[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (e.name === "dist" || e.name === "node_modules") return [];
    const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) return tsSources(child);
    if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) return [];
    return [{ url: child, src: readFileSync(child, "utf8") }];
  });
}

const roots = [
  new URL("../agent/", import.meta.url),
  ...(["discord", "github", "linear", "notion", "slack", "teams"] as const).map(
    (p) => new URL(`../../providers/${p}/agent/`, import.meta.url),
  ),
  new URL("../../../agent/", import.meta.url),
];
const sources = roots.flatMap(tsSources);

ok(sources.length > 250, `the scan walked every surface adapter's agent tree (${sources.length} .ts files) — not an empty set`);
ok(
  sources.some((f) => f.url.pathname.includes("/providers/slack/")) &&
    sources.some((f) => f.url.pathname.includes("/providers/discord/")) &&
    sources.some((f) => f.url.pathname.endsWith("/agent/agent.ts")),
  "the scan reached at least one provider package AND the repo-root agent definition — the root list above is not silently missing a directory",
);

const patterns: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "a tool embedding a file/content part via eve's toolOutputPart/toolOutput builders", re: /toolOutputPart\.file\(|toolOutput\.content\(/ },
  { label: "an import of eve's structured UserContent type", re: /import\s*(?:type\s*)?\{[^}]*\bUserContent\b[^}]*\}\s*from/ },
  { label: "eve's internal attachment-ref wire scheme (eve-sandbox: / eve-attachment:)", re: /eve-sandbox:|eve-attachment:/ },
  { label: "a direct call into eve's attachment-plane API", re: /encodeSandboxRef|encodeAttachmentRef|stageAttachmentsToSandbox|hydrateSandboxAttachments/ },
];

for (const { label, re } of patterns) {
  const hits = sources.filter((f) => re.test(f.src)).map((f) => f.url.pathname);
  ok(hits.length === 0, `no OE source constructs ${label} (found: ${hits.join(", ") || "none"})`);
}

const synthetic: Readonly<Record<string, string>> = {
  "a tool embedding a file/content part via eve's toolOutputPart/toolOutput builders": `return toolOutput.content([toolOutputPart.text("x"), toolOutputPart.file(b64, { mediaType: "image/png" })]);`,
  "an import of eve's structured UserContent type": `import type { ModelMessage, UserContent } from "ai";`,
  "eve's internal attachment-ref wire scheme (eve-sandbox: / eve-attachment:)": `const ref = new URL("eve-sandbox:?path=%2Fworkspace%2Fx.png&size=1&type=image%2Fpng");`,
  "a direct call into eve's attachment-plane API": `const hydrated = await hydrateSandboxAttachments(messages);`,
};
for (const { label, re } of patterns) {
  const sample = synthetic[label]!;
  ok(re.test(sample), `detector self-check: the "${label}" pattern DOES match its own synthetic positive example — the scan above is not vacuously green`);
}

console.log(`✓ attachment-hydration-hazard: ${passed} assertions passed`);
