export function processRegistryMap<V>(name: string): Map<string, V> {
  const key = Symbol.for(`open-everywhere.${name}`);
  const g = globalThis as { [k: symbol]: unknown };
  const existing = g[key];
  if (existing instanceof Map) return existing as Map<string, V>;
  const fresh = new Map<string, V>();
  g[key] = fresh;
  return fresh;
}

export function processRegistrySlot<V>(name: string): { get(): V | null; set(value: V | null): void } {
  const key = Symbol.for(`open-everywhere.${name}`);
  const g = globalThis as { [k: symbol]: unknown };
  if (!(g[key] instanceof Object) || !("oeSlot" in (g[key] as object))) g[key] = { oeSlot: null as V | null };
  const box = g[key] as { oeSlot: V | null };
  return {
    get: () => box.oeSlot,
    set: (value: V | null) => {
      box.oeSlot = value;
    },
  };
}
