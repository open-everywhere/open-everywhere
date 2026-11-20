import { fenceCatalogText } from "../access/untrusted.js";

/**
 * The catalog text of one connector op: what the model reads about the op before it calls it.
 *
 * A connector op is a deferred tool (`connector-tools.ts`). The model finds it with `eve__search`,
 * which returns the tool's `description` and a TypeScript signature that eve renders from the
 * tool's input schema (property names, property descriptions, `enum` and `const` values, `pattern`,
 * `format` and `default`). An `eve__tool` call with an invalid input gets the same signature back
 * in its error. The MCP server wrote all of that text, so it can carry an injected instruction.
 *
 * The op therefore offers eve two host-built values in place of the server's:
 *
 * - **The description** is a host-authored line that names the op and its connection. The server's
 *   description, and its input schema when the reduced schema below dropped any text, follow inside
 *   the `<untrusted_external_data>` envelope (`access/untrusted.ts#fenceCatalogText`). The model
 *   still reads every word the server wrote, so it can choose the op and fill its input, but only
 *   as fenced data.
 * - **The input schema** is the server's schema reduced to its shape: a fixed list of structural
 *   keywords. Every free-text keyword (`description`, `title`, `examples`, `$comment` and the
 *   rest) is dropped. An `enum`, `const` or `default` stays only when each value is a scalar short
 *   token, an `enum` holds at most `ENUM_MAX` values, and the op's literals fit in
 *   `LITERAL_BUDGET` characters. So the signature eve renders carries no free-text server field. It
 *   still carries server tokens: the property names (unbounded in number) and the bounded
 *   literals. A run of tokens can spell a sentence, as the op name can.
 *
 * eve validates a call's input against this schema, so the reduction never makes it stricter than
 * eve's own check of the server's schema: each step either keeps a keyword exactly or drops it,
 * and a drop that would make an outer keyword stricter drops that keyword too (`oneOf` becomes
 * `anyOf`; `not`, `if` and `maxContains` go). Where eve cannot check the server's schema at all
 * (`eveCanValidate`), the reduced schema keeps the property names alone and checks nothing. The
 * server still checks the input against its own schema.
 *
 * Names stay: the call needs them. A property name and a `required` entry must be a short token (`NAME_TOKEN`), or the op is left out of the mount with a warning, as an op whose
 * own name eve refuses is. A token can still spell words, as an op name can. That residue (names
 * and the bounded literals) is the same class as the op name, which every catalog listing shows.
 */

/** A name the schema may keep: a short token with no space and no punctuation that can frame a sentence. */
const NAME_TOKEN = /^[A-Za-z0-9_.$@-]{1,64}$/u;

/** A string literal (`enum`, `const`, `default`) the schema may keep. A URI or an id passes; a phrase does not. */
const LITERAL_TOKEN = /^[A-Za-z0-9_.$@:/#+-]{1,64}$/u;

/** A local `$ref`. eve's signature resolves it and never shows the pointer itself. */
const LOCAL_REF = /^#(?:\/[A-Za-z0-9_.$@~%-]+)*$/u;

/** At most this many `enum` values stay in the schema. A longer list goes inside the fence only. */
const ENUM_MAX = 16;

/** The characters of server literals one op's schema may keep, summed over every `enum`, `const` and `default`. */
const LITERAL_BUDGET = 200;

/** A `$schema` URI the validator knows. It never reaches the model, and it keeps the draft's semantics. */
const SCHEMA_URI = /^https?:\/\/json-schema\.org\/[A-Za-z0-9/._-]*#?$/u;

const JSON_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);

/** Keywords whose value is a number (or, for the exclusive bounds of an old draft, a boolean). Kept exactly. */
const NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
] as const;

/** Keywords that hold one sub-schema. A looser sub-schema makes each of them looser. */
const SUBSCHEMA_KEYWORDS = ["items", "additionalItems", "contains"] as const;

/** Keywords that hold a list of sub-schemas. `oneOf` is written as `anyOf`: a looser branch could match twice. */
const SCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** The free-text cap inside one op's fence. A search returns up to ten ops. */
const CATALOG_DETAIL_MAX = 2000;

export type ConnectorCatalogEntry =
  | { readonly ok: true; readonly description: string; readonly inputSchema: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

interface Reduction {
  /** True when the reduction dropped server text the model may need (a description, an enum of phrases). */
  dropped: boolean;
  /** The first name that is not a token, when there is one. The op is then left out. */
  badName?: string;
  /** The literal characters the schema may still keep (`LITERAL_BUDGET`). */
  budget: number;
  /**
   * True when the model reads the whole JSON Schema, as for a tool in its tool list, and not only
   * eve's rendered signature. Then a `$defs` key must be a short token too, and the root id goes.
   */
  shownWhole?: boolean;
}

/**
 * The id of a node when it opens a new `$id` resource. The validator (cfworker) reads an id with a
 * non-empty fragment as an anchor, which opens no new base, so that id opens no scope here either.
 */
function scopeId(rec: Record<string, unknown>): string | undefined {
  const id = typeof rec["$id"] === "string" ? rec["$id"] : typeof rec["id"] === "string" ? rec["id"] : undefined;
  if (id === undefined) return undefined;
  const hash = id.indexOf("#");
  return hash >= 0 && hash < id.length - 1 ? undefined : id;
}

/** Reduced nodes that had both `anyOf` and `oneOf`: a pointer through their `oneOf` has no plain rewrite. */
const mergedOneOf = new WeakSet<object>();

/** Write a map entry as an own property, so a name such as `__proto__` stays a name and never sets the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A scalar literal the schema may keep: a number, a boolean, `null`, or a short token. Never an object or an array. */
function isSafeScalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && (value === "" || LITERAL_TOKEN.test(value));
}

/** Keep these literals only when each is a safe scalar and they fit in what is left of the op's budget. */
function keepLiterals(values: readonly unknown[], r: Reduction): boolean {
  if (!values.every(isSafeScalar)) return false;
  const cost = values.reduce<number>((n, v) => n + String(v).length + 1, 0);
  if (cost > r.budget) return false;
  r.budget -= cost;
  return true;
}

function checkName(name: string, r: Reduction): boolean {
  if (NAME_TOKEN.test(name)) return true;
  r.badName ??= name;
  return false;
}

function reduceList(value: unknown, r: Reduction, depth: number): unknown[] | undefined {
  return Array.isArray(value) ? value.map((v) => reduceSchema(v, r, depth + 1)) : undefined;
}

/**
 * One schema node reduced to its shape. A boolean schema stays. Anything that is not a schema
 * becomes `{}` (accept anything), which is never stricter.
 */
function reduceSchema(node: unknown, r: Reduction, depth = 0): unknown {
  if (typeof node === "boolean") return node;
  const s = recordOf(node);
  if (s === undefined || depth > 32) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(s)) {
    if (!KNOWN_KEYWORDS.has(key)) r.dropped = true;
  }

  if (typeof s["$schema"] === "string" && SCHEMA_URI.test(s["$schema"])) out["$schema"] = s["$schema"];
  // A `$ref` below an embedded `$id` resolves against that id. Dropping the id would make it
  // resolve against the root, which can be stricter, so every string id stays as it is. eve's
  // signature never renders an id, and its validation messages never quote one.
  for (const key of ["$id", "id", "$anchor"] as const) {
    if (typeof s[key] !== "string") continue;
    // A model that reads the whole schema reads the root id too. Where eve can check the schema,
    // no id sits below the root and every `$ref` is a local pointer, so the root id changes no
    // resolution: it goes, and its text goes inside the fence.
    if (r.shownWhole === true && depth === 0 && key !== "$anchor") r.dropped = true;
    else out[key] = s[key];
  }
  if (typeof s["$ref"] === "string") {
    if (LOCAL_REF.test(s["$ref"])) out["$ref"] = s["$ref"];
    else r.dropped = true;
  }
  for (const defs of ["$defs", "definitions"] as const) {
    const d = recordOf(s[defs]);
    if (d === undefined) continue;
    const kept: Record<string, unknown> = {};
    // eve's signature never renders a `$defs` key: it resolves a `$ref` through it. A model that
    // reads the whole schema reads the key, so then it must be a short token, as a property name is.
    for (const [name, sub] of Object.entries(d)) {
      if (r.shownWhole === true && !checkName(name, r)) continue;
      setOwn(kept, name, reduceSchema(sub, r, depth + 1));
    }
    out[defs] = kept;
  }

  const type = s["type"];
  if (typeof type === "string" && JSON_TYPES.has(type)) out["type"] = type;
  else if (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string" && JSON_TYPES.has(t))) out["type"] = [...type];

  for (const key of ["enum", "const", "default"] as const) {
    if (!(key in s)) continue;
    const value = s[key];
    const safe = key === "enum" ? Array.isArray(value) && value.length <= ENUM_MAX && keepLiterals(value, r) : keepLiterals([value], r);
    if (safe) out[key] = Array.isArray(value) ? [...value] : value;
    else r.dropped = true;
  }

  for (const key of NUMERIC_KEYWORDS) {
    const v = s[key];
    if (typeof v === "number" || (typeof v === "boolean" && (key === "exclusiveMinimum" || key === "exclusiveMaximum"))) out[key] = v;
  }
  if (typeof s["uniqueItems"] === "boolean") out["uniqueItems"] = s["uniqueItems"];
  // OpenAPI's `nullable: true` admits `null`. eve's validator reads JSON Schema rules, so the
  // reduction writes it as a `"null"` type: looser than the server's schema read either way.
  if (s["nullable"] === true && out["type"] !== undefined) {
    const types = Array.isArray(out["type"]) ? (out["type"] as string[]) : [out["type"] as string];
    if (!types.includes("null")) out["type"] = [...types, "null"];
  }

  const props = recordOf(s["properties"]);
  if (props !== undefined) {
    const kept: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props)) if (checkName(name, r)) setOwn(kept, name, reduceSchema(sub, r, depth + 1));
    out["properties"] = kept;
  }
  if (Array.isArray(s["required"])) {
    const req = s["required"].filter((n): n is string => typeof n === "string");
    for (const n of req) checkName(n, r);
    out["required"] = req;
  }

  // patternProperties keys are server regexes. Dropping them is looser on its own, but with
  // additionalProperties also present the properties they matched would fall to it: drop both.
  const looseExtras = s["patternProperties"] !== undefined || s["unevaluatedProperties"] !== undefined;
  if ("additionalProperties" in s && !looseExtras) {
    const ap = s["additionalProperties"];
    out["additionalProperties"] = typeof ap === "boolean" ? ap : reduceSchema(ap, r, depth + 1);
  }

  for (const key of SUBSCHEMA_KEYWORDS) {
    if (!(key in s)) continue;
    const v = s[key];
    out[key] = Array.isArray(v) ? reduceList(v, r, depth) : reduceSchema(v, r, depth + 1);
  }
  const anyOf = reduceList(s["anyOf"], r, depth);
  const oneOf = reduceList(s["oneOf"], r, depth);
  const allOf = reduceList(s["allOf"], r, depth);
  const prefixItems = reduceList(s["prefixItems"], r, depth);
  if (prefixItems !== undefined) out["prefixItems"] = prefixItems;
  if (allOf !== undefined || (oneOf !== undefined && anyOf !== undefined)) {
    // With both anyOf and oneOf on one node, the loosened oneOf goes in as one more allOf branch.
    out["allOf"] = [...(allOf ?? []), ...(oneOf !== undefined && anyOf !== undefined ? [{ anyOf: oneOf }] : [])];
  }
  if (oneOf !== undefined && anyOf !== undefined) mergedOneOf.add(out);
  if (anyOf !== undefined) out["anyOf"] = anyOf;
  else if (oneOf !== undefined) out["anyOf"] = oneOf;
  return out;
}

/**
 * Every keyword the reduction reads. A keyword not on this list is dropped. `pattern`, `format`,
 * `not`, `if`/`then`/`else`, `propertyNames`, `patternProperties`, `dependencies`,
 * `dependentRequired`, `dependentSchemas`, `unevaluated*` and `maxContains` are dropped on
 * purpose: each holds server text, or a looser sub-schema would make it stricter.
 */
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "type",
  "enum",
  "const",
  "default",
  ...NUMERIC_KEYWORDS,
  "uniqueItems",
  "nullable",
  "$id",
  "id",
  "$anchor",
  "properties",
  "required",
  "additionalProperties",
  ...SUBSCHEMA_KEYWORDS,
  ...SCHEMA_LIST_KEYWORDS,
]);

/**
 * The pointer of `ref` in the reduced schema `root`, or `undefined` when it resolves nowhere. A
 * `oneOf` segment becomes `anyOf`, except on a node that had both: its `oneOf` moved into `allOf`.
 */
function repointRef(root: unknown, ref: string, rewrite = true): string | undefined {
  return locateRef(root, ref, rewrite)?.pointer;
}

function locateRef(root: unknown, ref: string, rewrite: boolean): { readonly pointer: string; readonly target: unknown } | undefined {
  let node: unknown = root;
  const out: string[] = [];
  // Without the rewrite, the lookup is the validator's: it registers a node only under a key it
  // walks, so a pointer into `enum`, `const`, `default` and the other ignored keys, or into an
  // array under any key but the schema-list keys, resolves to nothing.
  let parentKey: string | undefined;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    // The validator stores a key through its pointer escape, so a `~` not followed by `0` or `1`
    // names no key it registered.
    if (!rewrite && /~(?![01])/u.test(raw)) return undefined;
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    let next = raw;
    if (Array.isArray(node)) {
      if (!rewrite && (parentKey === undefined || !CFWORKER_ARRAY_KEYS.has(parentKey))) return undefined;
      // The validator registers an array entry under its plain decimal index only.
      if (!/^(?:0|[1-9][0-9]*)$/u.test(seg)) return undefined;
      node = node[Number(seg)];
      parentKey = undefined;
    } else {
      const rec = recordOf(node);
      if (rec === undefined) return undefined;
      if (rewrite && seg === "oneOf" && !Object.hasOwn(rec, "oneOf")) {
        if (mergedOneOf.has(rec)) return undefined;
        seg = "anyOf";
        next = "anyOf";
      }
      if (!Object.hasOwn(rec, seg)) return undefined;
      const isName = parentKey !== undefined && CFWORKER_MAP_KEYS.has(parentKey);
      if (!rewrite && !isName && CFWORKER_IGNORED_KEYS.has(seg)) return undefined;
      node = rec[seg];
      parentKey = isName ? undefined : seg;
    }
    if (node === undefined) return undefined;
    out.push(next);
  }
  // The validator never registers the object under a map keyword itself, only its values.
  if (!rewrite && parentKey !== undefined && CFWORKER_MAP_KEYS.has(parentKey)) return undefined;
  return { pointer: `#${out.map((x) => `/${x}`).join("")}`, target: node };
}

/**
 * Point each `$ref` at the reduced schema. A pointer through `oneOf` now goes through `anyOf`. The
 * validator resolves a pointer against the innermost enclosing `$id` resource (or the root), so the
 * rewrite does too. The server's own pointers all resolve (`eveCanValidate` checked that), so a
 * pointer that no longer resolves is one the rewrite cannot place: it is removed from its node,
 * and a node with no `$ref` is never stricter than one with it.
 */
function repairRefs(root: unknown): unknown {
  const walk = (node: unknown, resources: readonly unknown[], depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, resources, depth + 1);
      return;
    }
    const rec = recordOf(node);
    if (rec === undefined) return;
    const scope = scopeId(rec) !== undefined ? [...resources, rec] : resources;
    if (typeof rec["$ref"] === "string") {
      const ref = rec["$ref"];
      const repointed = repointRef(scope[scope.length - 1], ref);
      if (repointed !== undefined) rec["$ref"] = repointed;
      else delete rec["$ref"];
    }
    for (const [key, v] of Object.entries(rec)) if (key !== "enum" && key !== "const" && key !== "default") walk(v, scope, depth + 1);
  };
  walk(root, [root], 0);
  return root;
}

/** The keys the validator (cfworker) never walks for sub-schemas (`ignoredKeyword`). */
const CFWORKER_IGNORED_KEYS: ReadonlySet<string> = new Set([
  "id", "$id", "$ref", "$schema", "$anchor", "$vocabulary", "$comment", "default", "enum", "const", "required",
  "dependentRequired", "type", "maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf", "maxLength",
  "minLength", "pattern", "format", "maxItems", "minItems", "uniqueItems", "maxProperties", "minProperties",
]);

/** The only keys under which the validator walks an array (`schemaArrayKeyword`). */
const CFWORKER_ARRAY_KEYS: ReadonlySet<string> = new Set(["prefixItems", "items", "allOf", "anyOf", "oneOf"]);

/** The keys whose children the validator walks by name (`schemaMapKeyword`). */
const CFWORKER_MAP_KEYS: ReadonlySet<string> = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]);

/**
 * The walk depth past which a REDUCED schema counts as one eve cannot check. The reduction cuts
 * the server's schema at 32 levels, and each level adds at most a few walk steps, so a reduced
 * schema stays far below it. The cap is a guard against a deep call stack, never a rule of eve's.
 */
const REDUCED_WALK_MAX = 512;

/** The base URI the validator resolves a root without an id against (`initialBaseURI`). */
const CFWORKER_BASE = "https://github.com/cfworker";

/**
 * True when every id and every `$ref` in the schema is one the validator accepts with no doubt.
 * The validator (cfworker) registers ids through every key it walks, unknown keys included. It
 * registers an embedded id under each enclosing base, it lets an id with a fragment take the key
 * of a pointer, and it throws when an id is not a URL or names a resource twice. It also throws at
 * call time on a `$ref` that names nothing it registered. So this pass walks EVERY object and
 * array, and it counts as a cause any `$id` or `id` below the root (read as `$id || id`, any truthy
 * value), a root id that is not a URL or has a fragment, an `$anchor`, a `$recursiveRef`, a
 * `$dynamicRef`, a `$ref` with a percent escape, and a key that is not well-formed text. With no embedded id left, each `$ref` resolves against the root, and the pass
 * checks it with the validator's own lookup rules (`locateRef` without the rewrite). A cause only
 * makes the reduced schema looser.
 */
function idsAndRefsResolve(root: unknown, reduced = false): boolean {
  const wellFormed = (keys: readonly string[]): boolean => {
    for (const key of keys) {
      try {
        encodeURI(key);
      } catch {
        return false;
      }
    }
    return true;
  };
  // `map` is true for the object under a map keyword (`properties`, `$defs` and the rest). Its keys
  // are names, so a property named `id` or `$ref` is no id and no ref: only its values are schemas.
  const walk = (node: unknown, depth: number, map = false): boolean => {
    // A reduced schema can be deeper than the server's (a `oneOf` moves into `allOf`), so it takes a
    // wider cap. The reduction's own cap bounds it far below that one.
    if (depth > (reduced ? REDUCED_WALK_MAX : 64)) return false;
    if (Array.isArray(node)) return node.every((v) => walk(v, depth + 1));
    const s = recordOf(node);
    if (s === undefined) return true;
    // The validator builds a URI from every key it walks (`encodeURI`), which throws on a key that
    // is not well-formed text.
    if (!wellFormed(Object.keys(s))) return false;
    if (map) return Object.values(s).every((v) => walk(v, depth + 1));
    const id = s["$id"] || s["id"];
    if (id) {
      if (node !== root || typeof id !== "string") return false;
      try {
        if (new URL(id, CFWORKER_BASE).hash.length > 1) return false;
      } catch {
        return false;
      }
    }
    if (s["$anchor"] !== undefined || s["$recursiveRef"] !== undefined || s["$dynamicRef"] !== undefined) return false;
    if (s["$ref"] !== undefined) {
      const ref = s["$ref"];
      // The validator keeps a percent escape of a reserved character as it is, where `locateRef`
      // decodes it, so a pointer with any escape is a cause.
      if (typeof ref !== "string" || !LOCAL_REF.test(ref) || ref.includes("%")) return false;
      const target = locateRef(root, ref, false)?.target;
      if (typeof target !== "boolean" && recordOf(target) === undefined) return false;
    }
    return Object.entries(s).every(([key, v]) => walk(v, depth + 1, CFWORKER_MAP_KEYS.has(key)));
  };
  return walk(root, 0);
}

const VALIDATOR_SUBSCHEMA = ["additionalItems", "additionalProperties", "contains", "else", "if", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"] as const;
const VALIDATOR_SUBSCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const VALIDATOR_SUBSCHEMA_MAP = ["$defs", "definitions", "dependencies", "dependentSchemas", "patternProperties", "properties"] as const;

function isRegExpSource(source: unknown): boolean {
  if (typeof source !== "string") return false;
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * True when eve can check a call against this schema at all. eve's validator
 * (`eve/dist/src/tools/schema.js#prepareForValidation`) turns local validation off for the whole
 * tool when a sub-schema is not an object or a boolean, a `type` is not a JSON type, an `enum` is
 * not an array, a `required` entry is not a string, or a pattern is not a valid regex. The
 * validator (cfworker) also throws, and eve checks nothing, when an `$id` is not a URL or names a
 * resource twice, and when a call reaches a `$ref` that it cannot resolve to a schema. This mirrors
 * those rules. It counts any `$ref` that is not a local pointer, that resolves nowhere, or that
 * points at a non-schema value, as one eve cannot resolve, and a node deeper than the reduction's
 * cap as a cause too. Where eve checks nothing, the reduced schema must check nothing either.
 */
export function eveCanValidate(root: unknown, opts: { readonly reduced?: boolean } = {}): boolean {
  if (!idsAndRefsResolve(root, opts.reduced === true)) return false;
  const ok = (node: unknown, resources: readonly unknown[], depth: number): boolean => {
    if (typeof node === "boolean") return true;
    const s = recordOf(node);
    // Past the reduction's own depth cap the reduced schema is `{}`, so a deeper node could hide a
    // cause: count it as one. An already reduced schema (`opts.reduced`) is what eve checks, with no
    // cut below the cap, so it takes the wider cap. The reduction can add a level (a node's `oneOf`
    // moves into `allOf`), so the narrow cap would refuse a reduced schema that the server's own
    // schema passed.
    if (s === undefined || depth > (opts.reduced === true ? REDUCED_WALK_MAX : 32)) return false;
    const scope = scopeId(s) !== undefined ? [...resources, s] : resources;
    const type = s["type"];
    if (type !== undefined && !(Array.isArray(type) ? type.every((t) => typeof t === "string" && JSON_TYPES.has(t)) : typeof type === "string" && JSON_TYPES.has(type))) return false;
    if (s["enum"] !== undefined && !Array.isArray(s["enum"])) return false;
    if (s["required"] !== undefined && !(Array.isArray(s["required"]) && s["required"].every((n) => typeof n === "string"))) return false;
    if (s["pattern"] !== undefined && !isRegExpSource(s["pattern"])) return false;
    if (s["$ref"] !== undefined) {
      const ref = s["$ref"];
      if (typeof ref !== "string" || !LOCAL_REF.test(ref)) return false;
      const target = locateRef(scope[scope.length - 1], ref, false)?.target;
      // A pointer to a description, an enum list or any other non-schema makes the validator throw.
      if (typeof target !== "boolean" && recordOf(target) === undefined) return false;
    }
    for (const key of VALIDATOR_SUBSCHEMA) if (key in s && !ok(s[key], scope, depth + 1)) return false;
    const items = s["items"];
    for (const it of Array.isArray(items) ? items : items === undefined ? [] : [items]) if (!ok(it, scope, depth + 1)) return false;
    for (const key of VALIDATOR_SUBSCHEMA_LIST) {
      const list = s[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every((v) => ok(v, scope, depth + 1))) return false;
    }
    for (const key of VALIDATOR_SUBSCHEMA_MAP) {
      const map = s[key];
      if (map === undefined) continue;
      const rec = recordOf(map);
      if (rec === undefined) return false;
      for (const [name, sub] of Object.entries(rec)) {
        if (key === "patternProperties" && !isRegExpSource(name)) return false;
        if (key === "dependencies" && Array.isArray(sub)) continue;
        if (!ok(sub, scope, depth + 1)) return false;
      }
    }
    return true;
  };
  return ok(root, [root], 0);
}

/** The property names alone, each with no rule: it accepts every call, as eve does when it can check nothing. */
export function namesOnly(reduced: unknown): Record<string, unknown> {
  const props = recordOf(recordOf(reduced)?.["properties"]) ?? {};
  return { properties: Object.fromEntries(Object.keys(props).map((name) => [name, {}])) };
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […the connector's text is cut here]`;
}

export type ReducedInputSchema =
  | {
      readonly ok: true;
      /** The schema reduced to its shape. It is never stricter than eve's own check of the server's schema. */
      readonly inputSchema: Record<string, unknown>;
      /** True when the reduction dropped server text the model may need, so the caller fences the raw schema. */
      readonly dropped: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * A server's input schema reduced to its shape, by the rules this file's header states. The
 * connector catalog uses it, and so does a credential-grant borrowed tool
 * (`access/grant-schema-pin.ts#grantOfferSchema`), which offers the vendor's schema on a tool the
 * model sees in its tool list. A property name or a `required` entry that is not a short token
 * gives `ok: false`: the caller leaves the tool out.
 *
 * `shownWhole` is for a tool in the model's tool list. eve hands the provider a plain JSON schema
 * whole there (`eve/dist/src/tools/schema.js#toModelJsonSchema`), so the model reads keys that a
 * signature never renders. With it, a `$defs` or `definitions` key must be a short token, and the
 * root `$id` or `id` is dropped into the fence.
 */
export function reduceInputSchema(inputSchema: unknown, opts: { readonly shownWhole?: boolean } = {}): ReducedInputSchema {
  const r: Reduction = { dropped: false, budget: LITERAL_BUDGET, ...(opts.shownWhole === true ? { shownWhole: true } : {}) };
  const reduced = repairRefs(reduceSchema(inputSchema, r));
  if (r.badName !== undefined) {
    return { ok: false, reason: `its input schema names ${JSON.stringify(r.badName.slice(0, 40))}, which is not a short token, and the catalog shows a name outside the fence` };
  }
  const checkable = eveCanValidate(inputSchema);
  return { ok: true, dropped: r.dropped || !checkable, inputSchema: checkable ? (recordOf(reduced) ?? {}) : namesOnly(reduced) };
}

/** Server text inside the catalog envelope, capped at `CATALOG_DETAIL_MAX` characters. `source` is host-authored. */
export function fencedCatalogDetail(text: string, source: string): string {
  return fenceCatalogText(capped(text, CATALOG_DETAIL_MAX), { source });
}

/**
 * The description and input schema eve offers for one connector op, or the reason the op is left
 * out. `connection` is host-authored. `op` passed the mount's name rule (`connector-tool-name.ts`).
 */
export function connectorCatalogEntry(connection: string, op: string, description: string, inputSchema: unknown): ConnectorCatalogEntry {
  const reduced = reduceInputSchema(inputSchema);
  if (!reduced.ok) return reduced;
  const head = `The ${op} operation on the ${connection} connection.`;
  const vendor = description.trim();
  const parts: string[] = [];
  if (vendor.length > 0) parts.push(vendor);
  if (reduced.dropped) parts.push(`Input schema, as the server sent it: ${JSON.stringify(inputSchema)}`);
  if (parts.length === 0) return { ok: true, description: head, inputSchema: reduced.inputSchema };
  const fenced = fencedCatalogDetail(parts.join("\n\n"), `connector ${connection} catalog`);
  return {
    ok: true,
    description: `${head} The server's own description of it follows, as data.\n${fenced}`,
    inputSchema: reduced.inputSchema,
  };
}
