import { defineDurableSchema } from "eve/tools";

const DURABLE_SCHEMA = Symbol.for("eve:durable-dynamic-schema");
const DURABLE_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");
const TOOL_BRAND = Symbol.for("eve:tool-brand");

function isValidator(v: unknown): v is object {
  if (typeof v !== "object" || v === null || !("~standard" in v)) return false;
  const std = (v as { "~standard"?: { validate?: unknown } })["~standard"];
  return typeof std === "object" && std !== null && typeof std.validate === "function";
}

export function withTransformSchemaDescriptors<T extends object>(entry: T, stamped: string[] = [], label = "_single"): T {
  const copy = Object.defineProperties(Object.create(Object.getPrototypeOf(entry) as object | null) as object, Object.getOwnPropertyDescriptors(entry)) as T;
  const bag: Record<string, unknown> = { ...((Reflect.get(entry, DURABLE_TOOL_CALLBACKS) as Record<string, unknown> | undefined) ?? {}) };
  for (const phase of ["inputSchema", "outputSchema"] as const) {
    const schema = (entry as Record<string, unknown>)[phase];
    if (!isValidator(schema) || Reflect.get(schema, DURABLE_SCHEMA) !== undefined) continue;
    const wrapped = defineDurableSchema({ closure: {} as Record<string, never>, schema: () => schema as never }) as object;
    Object.defineProperty(copy, phase, { value: wrapped, enumerable: true, configurable: true, writable: true });
    bag[phase] = Reflect.get(wrapped, DURABLE_SCHEMA);
    stamped.push(`${label}.${phase}`);
  }
  Object.defineProperty(copy, DURABLE_TOOL_CALLBACKS, { configurable: true, value: bag });
  return copy;
}

export function withTransformSchemaStandIn(result: unknown, stamped: string[] = []): unknown {
  if (typeof result !== "object" || result === null) return result;
  if ((result as Record<symbol, unknown>)[TOOL_BRAND] === true) return withTransformSchemaDescriptors(result, stamped);
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, typeof v === "object" && v !== null ? withTransformSchemaDescriptors(v, stamped, k) : v]),
  );
}
