export interface OverlayModuleGrammar {
  readonly what: string;
  readonly header: string;
  readonly typeImport: string;
  readonly typeName: string;
}

export function overlayModulePrefix(g: OverlayModuleGrammar): string {
  return `${g.header}\n${g.typeImport}\n\nexport default `;
}

export function overlayModuleSuffix(g: OverlayModuleGrammar): string {
  return ` satisfies ${g.typeName};\n`;
}

export function wrapOverlayModule(g: OverlayModuleGrammar, canonicalJson: string): string {
  const body = canonicalJson.endsWith("\n") ? canonicalJson.slice(0, -1) : canonicalJson;
  return `${overlayModulePrefix(g)}${body}${overlayModuleSuffix(g)}`;
}

export function unwrapOverlayModule(g: OverlayModuleGrammar, text: string, refuse: (message: string) => Error): unknown {
  const prefix = overlayModulePrefix(g);
  const suffix = overlayModuleSuffix(g);
  if (!text.startsWith(prefix)) {
    throw refuse(
      `${g.what} module does not start with the generated header + \`export default \` (this file is machine-owned; run \`npm run overlays:normalize\` after editing its data, and never edit anything outside it)`,
    );
  }
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

export function overlayModuleHeader(what: string, codemodPath: string): string {
  return (
    `// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n` +
    `//\n` +
    `// The ${what}: DATA ONLY. Written exclusively by the deterministic codemod\n` +
    `// (${codemodPath}) on a bot-PR branch; the PR merge is the approval gate.\n` +
    `//\n` +
    `// \`npm run lint:overlays\` (in the \`npm test\` chain) re-emits this file from its own parsed\n` +
    `// content and FAILS on any byte difference, so a hand-edit — including one that adds executable\n` +
    `// code — cannot merge green. That check is what makes it safe for this data to live in a module.\n` +
    `//\n` +
    `// To change it by hand: edit the data below, then run \`npm run overlays:normalize\`.\n`
  );
}
