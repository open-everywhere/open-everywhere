export interface MemorySilo {
  readonly name: string;
  readonly provider?: string;
  readonly container?: string;
  readonly path?: string;
  readonly readOnly?: boolean;
  readonly recursive?: boolean;

  readonly connector?: string;
  readonly skill?: string;
  readonly location?: string;
  readonly note?: string;
}

export function defineMemorySilo(silo: MemorySilo): MemorySilo {
  return silo;
}

export function isPointer(silo: MemorySilo): boolean {
  return typeof silo.connector === "string" && silo.connector.length > 0;
}

export function assertSilosValid(silos: readonly MemorySilo[]): void {
  const bad: string[] = [];
  for (const s of silos) {
    const hasProvider = typeof s.provider === "string" && s.provider.length > 0;
    const hasConnector = isPointer(s);
    if (hasProvider && hasConnector) bad.push(`  "${s.name}" sets BOTH provider and connector (pick one)`);
    else if (!hasProvider && !hasConnector) bad.push(`  "${s.name}" sets NEITHER provider nor connector`);
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: every memory silo must be materialized (provider) XOR a pointer (connector):\n" +
        bad.join("\n") +
        "\n(memory/silo.ts / docs/memory-model.md)",
    );
  }
}
