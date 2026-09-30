export interface OverlayModuleGrammar {
  readonly what: string;
  readonly header: string;
  readonly typeImport: string;
  readonly typeName: string;
}

function overlayModulePrefix(g: OverlayModuleGrammar): string {
  return `${g.header}\n${g.typeImport}\n\nexport default `;
}

function overlayModuleSuffix(g: OverlayModuleGrammar): string {
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
    `// The codemod re-emits this file from its own parsed content and refuses to rewrite it when the\n` +
    `// bytes differ, so a hand-edit stops the next machine PR. Before a merge, nothing checks that the\n` +
    `// file is still data only unless the repository runs its own check: the person who merges the PR\n` +
    `// is the gate. Read a PR to this file as code, because it is code.\n` +
    `//\n` +
    `// To change it by hand, edit only the data below and keep the layout exactly as emitted.\n`
  );
}
