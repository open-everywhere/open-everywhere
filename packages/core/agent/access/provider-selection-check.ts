export interface CoreSeamSource {
  readonly path: string;
  readonly source: string;
}

export interface ProviderSelectionInput {
  readonly manifestSource: string;
  readonly wiringSource: string;
  readonly bundlesPresent: readonly string[];
  readonly appStubs: ReadonlyMap<string, string>;
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
};

const PROVIDER_PKG = /@open-everywhere\/provider-([a-z0-9-]+)/gu;
const MANIFEST_IMPORT = /import\s*\{\s*(register\w+Provider)\s*\}\s*from\s*"@open-everywhere\/provider-([a-z0-9-]+)\/agent\/register\.js"/gu;
const MANIFEST_ROW = /\{\s*id:\s*"([a-z0-9-]+)"\s*,\s*register:\s*(register\w+Provider)\s*[,}]/gu;
const STUB_PROVIDER = /@open-everywhere\/provider-([a-z0-9-]+)\//u;
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
  const present = new Set(input.bundlesPresent);

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      problems.push(`agent/lib/providers.ts declares provider "${row.id}" TWICE — one row per selected bundle`);
    }
    seen.add(row.id);
    if (row.importedFrom === undefined) {
      problems.push(
        `agent/lib/providers.ts row "${row.id}" uses ${row.registerFn}, which is not imported from the bundle package @open-everywhere/provider-<id> (its agent/register.js entry) — every selected bundle's register fn comes from its own package`,
      );
    } else if (row.importedFrom !== row.id) {
      problems.push(
        `agent/lib/providers.ts row "${row.id}" registers ${row.registerFn}, imported from @open-everywhere/provider-${row.importedFrom} — the row id and the package must be the same provider`,
      );
    }
  }
  if (rows.length === 0) {
    problems.push(
      `agent/lib/providers.ts declares NO providers — the selection manifest is the deployment's declaration of which bundles it carries; an instance with none can never wake on any surface`,
    );
  }

  for (const [fn, pkgId] of [...input.manifestSource.matchAll(MANIFEST_IMPORT)].map((m) => [m[1], m[2]] as const)) {
    if (!selected.has(pkgId)) {
      problems.push(
        `agent/lib/providers.ts imports ${fn} from @open-everywhere/provider-${pkgId} but declares no row for "${pkgId}" — remove the import or add the row`,
      );
    }
  }

  for (const id of selected) {
    if (!present.has(id)) {
      problems.push(`agent/lib/providers.ts selects "${id}" but packages/providers/${id}/ does not exist`);
    }
  }

  for (const [slug, src] of input.appStubs) {
    const m = STUB_PROVIDER.exec(src);
    if (!m) continue;
    if (!selected.has(m[1])) {
      problems.push(
        `agent/${slug}.ts re-exports @open-everywhere/provider-${m[1]} but "${m[1]}" is NOT in agent/lib/providers.ts — Eve mounts by FILENAME, so this stub keeps that platform's surface live while every registration for it is refused; delete the stub or select the provider`,
      );
    }
  }
  const stubbed = new Set<string>();
  for (const src of input.appStubs.values()) {
    const m = STUB_PROVIDER.exec(src);
    if (m) stubbed.add(m[1]);
  }
  for (const id of selected) {
    if (!stubbed.has(id)) {
      problems.push(
        `agent/lib/providers.ts selects "${id}" but no app-tree stub re-exports @open-everywhere/provider-${id} — Eve discovers channels/tools by filename, so the bundle registers seams nothing can ever reach`,
      );
    }
  }

  const deps = new Set(input.appDependencies);
  for (const id of selected) {
    if (!deps.has(`@open-everywhere/provider-${id}`)) {
      problems.push(`package.json does not depend on @open-everywhere/provider-${id}, which agent/lib/providers.ts selects — add it (workspace version "*")`);
    }
  }
  for (const dep of deps) {
    const m = /^@open-everywhere\/provider-([a-z0-9-]+)$/u.exec(dep);
    if (m && !selected.has(m[1])) {
      problems.push(`package.json depends on @open-everywhere/provider-${m[1]} but agent/lib/providers.ts does not select it — drop the dependency or add the row`);
    }
  }

  if (!/declareProviderSelection\s*\(/u.test(input.wiringSource)) {
    problems.push(
      `agent/lib/register-adapters.ts never calls declareProviderSelection(...) — without the declaration core stays in library mode and the boot gate admits EVERY provider`,
    );
  }
  {
    const declareAt = input.wiringSource.search(/declareProviderSelection\s*\(/u);
    const firstRegisterAt = input.wiringSource.search(/\.register\(\)/u);
    if (declareAt >= 0 && firstRegisterAt >= 0 && firstRegisterAt < declareAt) {
      problems.push(
        `agent/lib/register-adapters.ts registers a provider BEFORE declareProviderSelection(...) — rows that land ahead of the declaration predate the gate and cannot be retracted; declare first`,
      );
    }
  }
  for (const m of input.wiringSource.matchAll(PROVIDER_PKG)) {
    problems.push(
      `agent/lib/register-adapters.ts references @open-everywhere/provider-${m[1]} directly — provider selection lives in agent/lib/providers.ts alone, so there is exactly ONE list to prune`,
    );
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
