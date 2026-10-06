export interface CoreSeamSource {
  readonly path: string;
  readonly source: string;
}

export interface ProviderSelectionInput {
  readonly manifestSource: string;
  readonly wiringSource: string;
  readonly appWiringSource?: string;
  readonly appDependencies: readonly string[];
  readonly coreSeams: readonly CoreSeamSource[];
  readonly fullCoreSweep?: boolean;
}

export interface ParsedProviderRow {
  readonly id: string;
  readonly registerFn: string;
  readonly importedFrom?: string;
}

export const UNGATED_SEAMS: Readonly<Record<string, string>> = {
  registerAuditDropCounter: "injects a single process-wide audit-drop counter; the `platform` is a callback ARGUMENT, not a registry key — nothing per-provider is stored",
  registerControlWriteTools: "registers control-plane MCP tools keyed by TOOL NAME; the `.platform` it touches is a linked-identity row's data column, not a per-provider registry key",
  registerWorkPlatform: "records a platform an ALREADY-ADMITTED adapter registration named; both callers gate with admitProviderRegistration before reaching it (proven in work-destinations-test §6)",
  registeredWorkRole: "a pure READ of that registry — it stores nothing and admits nothing; the name matches the sweep's `register*` shape by accident of English",
};

const PROVIDER_PKG = /@open-everywhere\/provider-([a-z0-9-]+)/gu;
const MANIFEST_IMPORT = /import\s*\{\s*(register\w+Provider)\s*\}\s*from\s*"@open-everywhere\/provider-([a-z0-9-]+)\/agent\/register\.js"/gu;
const MANIFEST_ROW = /\{\s*id:\s*"([a-z0-9-]+)"\s*,\s*register:\s*(register\w+Provider)\s*[,}]/gu;
const CORE_SEAM = /^export function (register\w+)(?:<[^>]*>)?\(([\s\S]*?)\):\s*[^{]*\{([\s\S]*?)^\}/gmu;

export function parseProviderManifest(manifestSource: string): ParsedProviderRow[] {
  const imports = new Map<string, string>();
  for (const m of manifestSource.matchAll(MANIFEST_IMPORT)) imports.set(m[1], m[2]);
  const rows: ParsedProviderRow[] = [];
  for (const m of manifestSource.matchAll(MANIFEST_ROW)) {
    const importedFrom = imports.get(m[2]);
    rows.push({ id: m[1], registerFn: m[2], ...(importedFrom ? { importedFrom } : {}) });
  }
  return rows;
}

export function checkProviderSelection(input: ProviderSelectionInput): string[] {
  const problems: string[] = [];
  const rows = parseProviderManifest(input.manifestSource);
  const selected = new Set(rows.map((r) => r.id));

  if (rows.length === 0) {
    problems.push(
      `agent/lib/providers.generated.ts declares NO providers — roster.config.ts's \`providers\` map is this deployment's declaration of which bundles it carries; an instance with none can never wake on any surface`,
    );
  }

  const deps = new Set(input.appDependencies);
  for (const id of selected) {
    if (!deps.has(`@open-everywhere/provider-${id}`)) {
      problems.push(`package.json does not depend on @open-everywhere/provider-${id}, which roster.config.ts selects — add it (workspace version "*")`);
    }
  }
  for (const dep of deps) {
    const m = /^@open-everywhere\/provider-([a-z0-9-]+)$/u.exec(dep);
    if (m && !selected.has(m[1])) {
      problems.push(`package.json depends on @open-everywhere/provider-${m[1]} but roster.config.ts does not select it — drop the dependency or add \`providers.${m[1]}\``);
    }
  }

  if (!/declareProviderSelection\s*\(/u.test(input.wiringSource)) {
    problems.push(
      `the boot wiring (registerDefaultAdapters) never calls declareProviderSelection(...) — without the declaration core stays in library mode and the boot gate admits EVERY provider`,
    );
  }
  {
    const declareAt = input.wiringSource.search(/declareProviderSelection\s*\(/u);
    const firstRegisterAt = input.wiringSource.search(/\.register\(\)/u);
    if (declareAt >= 0 && firstRegisterAt >= 0 && firstRegisterAt < declareAt) {
      problems.push(
        `the boot wiring (registerDefaultAdapters) registers a provider BEFORE declareProviderSelection(...) — rows that land ahead of the declaration predate the gate and cannot be retracted; declare first`,
      );
    }
  }
  for (const m of input.wiringSource.matchAll(PROVIDER_PKG)) {
    problems.push(
      `the boot wiring (registerDefaultAdapters) references @open-everywhere/provider-${m[1]} directly — provider selection lives in roster.config.ts alone, so there is exactly ONE list to prune`,
    );
  }

  if (input.appWiringSource !== undefined) {
    if (!/\bregisterDefaultAdapters\s*\(/u.test(input.appWiringSource)) {
      problems.push(
        `agent/lib/register-adapters.ts never calls registerDefaultAdapters(...) — the app's copy wires the adapters by hand, and an upgrade of @open-everywhere/adapters no longer reaches it`,
      );
    }
    for (const m of input.appWiringSource.matchAll(PROVIDER_PKG)) {
      problems.push(
        `agent/lib/register-adapters.ts references @open-everywhere/provider-${m[1]} directly — provider selection lives in roster.config.ts alone, so there is exactly ONE list to prune`,
      );
    }
  }

  for (const { path, source } of input.coreSeams) {
    for (const m of source.matchAll(CORE_SEAM)) {
      const [, name, params, body] = m;
      const providerPlane = /\bplatform\s*\??\s*:/u.test(params) || /\.platform\b/u.test(body);
      if (!providerPlane) continue;
      if (Object.prototype.hasOwnProperty.call(UNGATED_SEAMS, name)) continue;
      if (/admitProviderRegistration\s*\(/u.test(body)) continue;
      problems.push(
        `packages/core/agent/${path}: ${name}() is a provider-plane registration seam (keyed by a platform) but never calls admitProviderRegistration(...) — an unselected provider would get a live row in this registry. Gate it, or declare it in UNGATED_SEAMS (access/provider-selection-check.ts) with the reason it carries no per-provider row.`,
      );
    }
  }
  if (input.fullCoreSweep) {
    const seamNames = new Set<string>();
    for (const { source } of input.coreSeams) for (const m of source.matchAll(CORE_SEAM)) seamNames.add(m[1]);
    for (const name of Object.keys(UNGATED_SEAMS)) {
      if (!seamNames.has(name)) {
        problems.push(`UNGATED_SEAMS names "${name}", which is no longer an exported core register* seam — remove the exemption (a stale row hides a real gap)`);
      }
    }
  }

  return problems;
}
