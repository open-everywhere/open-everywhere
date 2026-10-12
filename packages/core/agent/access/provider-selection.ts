export interface ProviderRegistrationRefusal {
  readonly provider: string;
  readonly seam: string;
}

let SELECTION: ReadonlySet<string> | undefined;

const REFUSALS: ProviderRegistrationRefusal[] = [];
const WARNED = new Set<string>();

const ADMITTED = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(`[open-everywhere:provider-selection] ${message}`);
}

export function declareProviderSelection(ids: Iterable<string>): readonly string[] {
  const set = new Set<string>();
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed.length > 0) set.add(trimmed);
  }
  for (const early of ADMITTED) {
    if (set.has(early)) continue;
    console.warn(
      `[open-everywhere:provider-selection] provider "${early}" registered a seam BEFORE the selection was declared and is NOT selected — that row predates the gate and cannot be retracted. It comes from core's own module-load wiring (the SCM issue adapter is the only such row today); move it behind the boot wiring if this deployment must not carry it.`,
    );
  }
  SELECTION = set;
  ADMITTED.clear();
  REFUSALS.length = 0;
  WARNED.clear();
  return [...set].sort();
}

export function providerSelection(): readonly string[] | undefined {
  return SELECTION === undefined ? undefined : [...SELECTION].sort();
}

export function providerSelectionDeclared(): boolean {
  return SELECTION !== undefined;
}

const CORE_PROTOCOL_PLATFORMS: ReadonlySet<string> = new Set(["a2a"]);

export function isProviderSelected(provider: string): boolean {
  return SELECTION === undefined || SELECTION.has(provider) || CORE_PROTOCOL_PLATFORMS.has(provider);
}

export function admitProviderRegistration(provider: string, seam: string): boolean {
  if (isProviderSelected(provider)) {
    if (SELECTION === undefined && !CORE_PROTOCOL_PLATFORMS.has(provider)) ADMITTED.add(provider);
    return true;
  }
  REFUSALS.push({ provider, seam });
  warnOnce(
    `${provider}\u0000${seam}`,
    `REFUSED ${seam} registration for provider "${provider}" — it is not in this deployment's declared selection [${[...(SELECTION ?? [])].sort().join(", ") || "(none)"}]. The platform stays absent from that registry and every resolution through it fails closed. If this deployment should carry it, add it to agent/lib/providers.ts (and its app-tree stubs + workspace dependency — scripts/provider-selection-lint.ts pins all four together).`,
  );
  return false;
}

export function admitInboundSurface(provider: string): boolean {
  if (isProviderSelected(provider)) return true;
  warnOnce(
    `inbound\u0000${provider}`,
    `REFUSED an inbound wake from provider "${provider}" — it is not in this deployment's declared selection [${[...(SELECTION ?? [])].sort().join(", ") || "(none)"}]. The wake is dropped (audited), not delivered.`,
  );
  return false;
}

export function refusedProviderRegistrations(): readonly ProviderRegistrationRefusal[] {
  return [...REFUSALS];
}

export function clearProviderSelection(): void {
  SELECTION = undefined;
  ADMITTED.clear();
  REFUSALS.length = 0;
  WARNED.clear();
}
