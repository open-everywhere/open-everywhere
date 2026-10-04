export interface OverlayModuleGrammar {
  readonly what: string;
  readonly header: string;
  readonly typeImport: string;
  readonly typeName: string;
}

const OVERLAY_BANNER = "// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.";

const OVERLAY_NORMALIZE_COMMAND = "npx oe overlays normalize";

function overlayModuleAfterHeaderPrefix(g: OverlayModuleGrammar): string {
  return `\n${g.typeImport}\n\nexport default `;
}

function overlayModulePrefix(g: OverlayModuleGrammar): string {
  return `${g.header}${overlayModuleAfterHeaderPrefix(g)}`;
}

const OTHER_LINE_TERMINATOR = /[\r\u2028\u2029]/u;

const TS_DIRECTIVE = /^\/\/(?:\/|\s*@)/u;

function overlayHeaderLength(text: string): number | undefined {
  let at = 0;
  let lines = 0;
  while (text.startsWith("//", at)) {
    const end = text.indexOf("\n", at);
    if (end < 0) return undefined;
    const line = text.slice(at, end);
    if (OTHER_LINE_TERMINATOR.test(line) || TS_DIRECTIVE.test(line)) return undefined;
    if (lines === 0 && line !== OVERLAY_BANNER) return undefined;
    lines++;
    at = end + 1;
  }
  return lines === 0 ? undefined : at;
}

function overlayModuleSuffix(g: OverlayModuleGrammar): string {
  return ` satisfies ${g.typeName};\n`;
}

export function wrapOverlayModule(g: OverlayModuleGrammar, canonicalJson: string): string {
  const body = canonicalJson.endsWith("\n") ? canonicalJson.slice(0, -1) : canonicalJson;
  return `${overlayModulePrefix(g)}${body}${overlayModuleSuffix(g)}`;
}

export function unwrapOverlayModule(g: OverlayModuleGrammar, text: string, refuse: (message: string) => Error): unknown {
  const headerLength = overlayHeaderLength(text);
  const prefixTail = overlayModuleAfterHeaderPrefix(g);
  const suffix = overlayModuleSuffix(g);
  if (headerLength === undefined || !text.startsWith(prefixTail, headerLength)) {
    throw refuse(
      `${g.what} module does not start with the generated header + \`export default \` (this file is machine-owned; run \`${OVERLAY_NORMALIZE_COMMAND}\` after editing its data, and never edit anything outside it)`,
    );
  }
  const prefix = text.slice(0, headerLength) + prefixTail;
  if (!text.endsWith(suffix)) {
    throw refuse(
      `${g.what} module does not end with \`${suffix.trimEnd()}\` — it must contain exactly one \`export default <data> satisfies ${g.typeName};\` statement and nothing else`,
    );
  }
  if (text.length < prefix.length + suffix.length) {
    throw refuse(`${g.what} module has no data between its header and its \`satisfies\` clause`);
  }
  const body = text.slice(prefix.length, text.length - suffix.length);
  try {
    return JSON.parse(body) as unknown;
  } catch (err) {
    throw refuse(`${g.what} module's data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function sameOverlayModuleAfterHeader(emitted: string, text: string): boolean {
  const a = overlayHeaderLength(emitted);
  const b = overlayHeaderLength(text);
  return a !== undefined && b !== undefined && emitted.slice(a) === text.slice(b);
}

export function overlayModuleHeader(what: string, codemodModule: string): string {
  return (
    `${OVERLAY_BANNER}\n` +
    `//\n` +
    `// The ${what}: DATA ONLY. Written exclusively by the deterministic codemod\n` +
    `// (${codemodModule}) on a bot-PR branch; the PR merge is the approval gate.\n` +
    `//\n` +
    `// The codemod re-emits this file from its own parsed content and refuses to rewrite it when the\n` +
    `// data or the import differ, so a hand-edit there stops the next machine PR. Before a merge,\n` +
    `// nothing checks that the file is still data only unless the repository runs\n` +
    `// \`npx oe build --check\` or \`npx oe overlays check\`: the person who merges the PR is the gate.\n` +
    `// Read a PR to this file as code, because it is code.\n` +
    `//\n` +
    `// To change it by hand, edit only the data below, then run \`${OVERLAY_NORMALIZE_COMMAND}\`.\n`
  );
}
