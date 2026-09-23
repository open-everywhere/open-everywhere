import { asSchema, jsonSchema } from "ai";

type Json = Record<string, unknown>;

interface ToolWithInputSchema {
  inputSchema?: unknown;
}

interface ValidatingSchema {
  readonly jsonSchema: unknown;
  readonly validate?: (value: unknown) => unknown;
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return isRecord(v) && typeof (v as { then?: unknown }).then === "function";
}

const CONSTRAINT_KEYS = ["type", "enum", "const", "anyOf", "oneOf", "allOf", "not", "$ref", "properties", "items"] as const;

export function allowsNull(node: unknown): boolean {
  if (node === true) return true;
  if (!isRecord(node)) return false;
  if (!CONSTRAINT_KEYS.some((k) => k in node)) return true;
  const type = node["type"];
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  if (Array.isArray(node["enum"]) && (node["enum"] as unknown[]).includes(null)) return true;
  if ("const" in node && node["const"] === null) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.some(allowsNull)) return true;
  }
  return false;
}

function withNull(node: Json): Json {
  const type = node["type"];
  const addEnumNull = (n: Json): Json => (Array.isArray(n["enum"]) ? { ...n, enum: [...(n["enum"] as unknown[]), null] } : n);
  if (typeof type === "string" && !("const" in node)) return addEnumNull({ ...node, type: [type, "null"] });
  if (Array.isArray(type) && !("const" in node)) return addEnumNull({ ...node, type: [...type, "null"] });
  if (Array.isArray(node["anyOf"])) return { ...node, anyOf: [...(node["anyOf"] as unknown[]), { type: "null" }] };
  const { description, title, default: dflt, ...rest } = node;
  return {
    ...(description !== undefined ? { description } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(dflt !== undefined ? { default: dflt } : {}),
    anyOf: [rest, { type: "null" }],
  };
}

function requiredOf(node: Json): readonly string[] {
  return Array.isArray(node["required"]) ? (node["required"] as string[]) : [];
}

export function nullableOptionalJsonSchema(node: unknown): unknown {
  if (!isRecord(node)) return node;
  let out: Json = node;
  const properties = node["properties"];
  if (isRecord(properties)) {
    const required = requiredOf(node);
    let changed = false;
    const next: Json = {};
    for (const [key, prop] of Object.entries(properties)) {
      let p = nullableOptionalJsonSchema(prop);
      if (!required.includes(key) && isRecord(p) && !allowsNull(p)) p = withNull(p);
      if (p !== prop) changed = true;
      next[key] = p;
    }
    if (changed) out = { ...out, properties: next };
  }
  const items = node["items"];
  if (isRecord(items)) {
    const nextItems = nullableOptionalJsonSchema(items);
    if (nextItems !== items) out = { ...out, items: nextItems };
  }
  return out;
}

export function stripAddedNulls(node: unknown, value: unknown): unknown {
  if (!isRecord(node)) return value;
  if (Array.isArray(value)) {
    const items = node["items"];
    return isRecord(items) ? value.map((v) => stripAddedNulls(items, v)) : value;
  }
  const properties = node["properties"];
  if (!isRecord(value) || !isRecord(properties)) return value;
  const required = requiredOf(node);
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    const prop = properties[key];
    if (prop === undefined) {
      out[key] = v;
      continue;
    }
    if (v === null && !required.includes(key) && !allowsNull(prop)) continue;
    out[key] = stripAddedNulls(prop, v);
  }
  return out;
}

export function optionalNonNullablePaths(node: unknown, at = ""): string[] {
  if (!isRecord(node)) return [];
  const found: string[] = [];
  const properties = node["properties"];
  if (isRecord(properties)) {
    const required = requiredOf(node);
    for (const [key, prop] of Object.entries(properties)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (!required.includes(key) && isRecord(prop) && !allowsNull(prop)) found.push(path);
      found.push(...optionalNonNullablePaths(prop, path));
    }
  }
  const items = node["items"];
  if (isRecord(items)) found.push(...optionalNonNullablePaths(items, `${at}[]`));
  return found;
}

const replacements = new WeakMap<object, unknown>();
const ours = new WeakSet<object>();

export function nullableOptionalSchema(current: unknown): unknown {
  if (current === null || typeof current !== "object") return undefined;
  if (ours.has(current)) return undefined;
  const cached = replacements.get(current);
  if (cached !== undefined) return cached;

  const original = asSchema(current as never) as unknown as ValidatingSchema;
  const source = original.jsonSchema;
  let advertised: unknown;
  if (isThenable(source)) {
    advertised = async () => nullableOptionalJsonSchema(await source);
  } else {
    const rewritten = nullableOptionalJsonSchema(source);
    if (rewritten === source) return undefined;
    advertised = rewritten;
  }

  const replacement = jsonSchema(advertised as never, {
    validate: async (value: unknown) => {
      const stripped = stripAddedNulls(await source, value);
      if (typeof original.validate !== "function") return { success: true as const, value: stripped };
      return (await original.validate(stripped)) as { success: true; value: unknown } | { success: false; error: Error };
    },
  });
  replacements.set(current, replacement);
  ours.add(replacement as object);
  return replacement;
}

export function nullableOptionalToolSet(toolset: Record<string, unknown>): void {
  for (const raw of Object.values(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as ToolWithInputSchema;
    let replacement: unknown;
    try {
      replacement = nullableOptionalSchema(tool.inputSchema);
    } catch {
      continue;
    }
    if (replacement !== undefined) tool.inputSchema = replacement;
  }
}
