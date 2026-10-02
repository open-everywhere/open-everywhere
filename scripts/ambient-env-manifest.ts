export interface LegSource {
  readonly label: string;
  readonly file: string;
  readonly source: string;
}

export type DeclaredClass =
  | "deliberate"
  | "pending-fix";

export interface DeclaredRead {
  readonly klass: DeclaredClass;
  readonly why: string;
}

export function declarationKey(file: string, name: string): string {
  return `${file} ${name}`;
}

export const WHOLE_ENV = "WHOLE-ENV";

export const PASS_THROUGH: ReadonlyMap<string, string> = new Map([
  [
    "PATH",
    "the host's own executable search path. Three suites forward it to a spawned child so the child " +
      "can find `node`, `npm` and `git`; the fourth (packages/adapters/scripts/aws-adapter-test.ts) " +
      "asserts the value survives an enumerated pass-through, comparing it to itself. No suite " +
      "branches on its content, and one that could not spawn its child would fail loudly.",
  ],
  [
    "NODE_OPTIONS",
    "the host's own Node flags, inherited and appended to when a suite spawns a child under a " +
      "loader (scripts/overlay-lint-test.ts). Same class as PATH: forwarded, never read for a verdict.",
  ],
]);

export const AMBIENT_READ_MANIFEST: ReadonlyMap<string, DeclaredRead> = new Map([
  [
    declarationKey("scripts/config-diff-test.ts", WHOLE_ENV),
    {
      klass: "deliberate",
      why:
        "the host's real environment remains part of the subject: the suite proves no secret-shaped " +
        "value from THIS shell reaches the config snapshot that gets posted on a pull request. The " +
        "suite also injects one owned probe so a scrubbed runner exercises the assertion, while this " +
        "whole-environment read keeps values a developer machine really carries in the scan.",
    },
  ],
  [
    declarationKey("scripts/model-stack-policy-test.ts", WHOLE_ENV),
    {
      klass: "deliberate",
      why:
        "`getSettings(env, overrides)` takes the environment as a parameter, and the suite passes " +
        "the real one to assert what THIS deployment resolves. Every behaviour spec in the schema " +
        "is code-only (settings.ts `resolve()` reads env for `models.stack` alone), so a host " +
        "variable cannot move any number this suite pins.",
    },
  ],
  [
    declarationKey("deploy/egress-proxy/control/server-boot-test.ts", WHOLE_ENV),
    {
      klass: "deliberate",
      why:
        "the suite copies the host environment to build the child control service's env, exactly as " +
        "`entrypoint.sh` does, and drops `OE_EGRESS_PROXY_TOKEN` on the way so the operator's real " +
        "token is never inherited. It is the pass-through shape written as a loop rather than a " +
        "spread, and it asserts nothing about what the host carries.",
    },
  ],
]);

export function codeOnly(source: string): string {
  const out: string[] = [];
  let prev = "";
  let prevWord = "";
  let i = 0;
  const templates: number[] = [];
  let braceDepth = 0;

  const blank = (n: number): void => {
    for (let k = 0; k < n; k++) out.push(" ");
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(stop - i);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k++) out.push(source[k] === "\n" ? "\n" : " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
          blank(2);
          i += 2;
          continue;
        }
        blank(1);
        i++;
      }
      if (i < source.length && source[i] === c) {
        out.push(c);
        i++;
      }
      prev = "s";
      prevWord = "";
      continue;
    }
    const consumeTemplateText = (): number => {
      let j = i;
      while (j < source.length) {
        const t = source[j]!;
        if (t === "\\" && j + 1 < source.length) {
          out.push(" ", source[j + 1] === "\n" ? "\n" : " ");
          j += 2;
          continue;
        }
        if (t === "`") {
          out.push("`");
          templates.pop();
          return j + 1;
        }
        if (t === "$" && source[j + 1] === "{") {
          out.push("$", "{");
          braceDepth++;
          return j + 2;
        }
        out.push(t === "\n" ? "\n" : " ");
        j++;
      }
      return j;
    };

    if (c === "`") {
      out.push(c);
      i++;
      templates.push(braceDepth);
      i = consumeTemplateText();
      prev = "s";
      prevWord = "";
      continue;
    }
    if (c === "}" && templates.length > 0 && braceDepth === templates[templates.length - 1]! + 1) {
      out.push("}");
      i++;
      braceDepth--;
      i = consumeTemplateText();
      prev = "s";
      prevWord = "";
      continue;
    }
    if (c === "/" && regexCanStartAfter(prev, prevWord)) {
      const closed = blankRegex(source, i, out);
      if (closed > i) {
        i = closed;
        prev = "s";
        continue;
      }
    }
    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth--;
    out.push(c);
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = IDENT.test(c) ? prevWord + c : "";
    }
    i++;
  }
  return out.join("");
}

const IDENT = /[A-Za-z0-9_$]/;

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexCanStartAfter(prev: string, prevWord: string): boolean {
  if (prev === "") return true;
  if (REGEX_KEYWORDS.has(prevWord)) return true;
  return !/[A-Za-z0-9_$)\]}s]/.test(prev);
}

function blankRegex(source: string, start: number, out: string[]): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") return start;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < source.length && /[a-z]/.test(source[i]!)) i++;
      out.push("/");
      for (let k = start + 1; k < i; k++) out.push(" ");
      return i;
    }
    i++;
  }
  return start;
}

export interface EnvUse {
  readonly reads: ReadonlyMap<string, number>;
  readonly pins: ReadonlySet<string>;
  readonly dynamicPin: boolean;
  readonly dynamicPins: ReadonlySet<string>;
  readonly wholeEnv: readonly number[];
  readonly aliasedEnv: readonly number[];
}

const ENV_ACCESS = /process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|(\[))/g;

const QUOTED_KEY = /^\[\s*(["'])([^"'\n]*)\1\s*\]/;

export function envUseIn(source: string): EnvUse {
  const code = codeOnly(source);
  const lineOf = (index: number): number => code.slice(0, index).split("\n").length;

  const reads = new Map<string, number>();
  const pins = new Set<string>();
  for (const m of code.matchAll(ENV_ACCESS)) {
    let name = m[1];
    let end = m.index + m[0].length;
    if (m[2] !== undefined) {
      const bracketAt = end - 1;
      const quoted = QUOTED_KEY.exec(source.slice(bracketAt));
      if (!quoted) continue;
      name = quoted[2]!;
      end = bracketAt + quoted[0].length;
    }
    if (name === undefined) continue;
    const after = code.slice(end);
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    const assigned = /^\s*=(?!=)/.test(after);
    const deleted = /\bdelete\s*$/.test(before);
    if (assigned || deleted) pins.add(name);
    if (!reads.has(name)) reads.set(name, lineOf(m.index));
  }
  for (const name of pins) reads.delete(name);

  const dynamicPin =
    /process\s*\.\s*env\s*\[[^\]"'\n]*\]\s*=(?!=)/.test(code) || /delete\s+process\s*\.\s*env\s*\[[^\]"'\n]*\]/.test(code);
  const dynamicPins = new Set<string>();
  if (dynamicPin) {
    for (const literal of codeStrings(code, source)) if (ENV_SHAPED.test(literal)) dynamicPins.add(literal);
  }

  const wholeEnv: number[] = [];
  for (const m of code.matchAll(/(\.\.\.\s*)?process\s*\.\s*env\b/g)) {
    if (m[1]) continue;
    const after = code.slice(m.index + m[0].length);
    if (/^\s*(\.|\[)/.test(after)) continue;
    wholeEnv.push(lineOf(m.index));
  }

  const aliasedEnv: number[] = [];
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*(["'])/g)) {
    if (!/(^|[\s,])env([\s,]|$)/.test(m[1]!)) continue;
    const quoteAt = m.index + m[0].length - 1;
    const spec = QUOTED_SPECIFIER.exec(source.slice(quoteAt));
    if (spec && (spec[2] === "node:process" || spec[2] === "process")) aliasedEnv.push(lineOf(m.index));
  }
  for (const m of code.matchAll(/process\s*\[\s*["']/g)) {
    const quoteAt = m.index + m[0].length - 1;
    const spec = QUOTED_SPECIFIER.exec(source.slice(quoteAt));
    if (spec && spec[2] === "env") aliasedEnv.push(lineOf(m.index));
  }

  return { reads, pins, dynamicPin, dynamicPins, wholeEnv, aliasedEnv };
}

const QUOTED_SPECIFIER = /^(["'])([^"'\n]*)\1/;

const ENV_SHAPED = /^[A-Z][A-Z0-9_]{2,}$/;

function codeStrings(code: string, source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'") continue;
    const close = code.indexOf(quote, i + 1);
    if (close === -1) break;
    out.push(source.slice(i + 1, close));
    i = close;
  }
  return out;
}

export const AMBIENT_READ_REMEDY =
  "How to clear one of these. PIN the variable — set or delete it in the suite itself, so the value " +
  "under test is the suite's own. `packages/core/scripts/host-egress-proxy-test.ts` is the model, and " +
  "`scripts/chain/_run-shard.ts` restores the environment around every leg, so a pin cannot reach a " +
  "shard-mate. 🔴 `process.env.X ??= \"…\"` is a DEFAULT, not a pin: it keeps whatever the host set. " +
  "If the host's value is genuinely the subject of the assertion, DECLARE the read in " +
  "AMBIENT_READ_MANIFEST (scripts/ambient-env-manifest.ts) as `deliberate` with a reason, or as " +
  "`pending-fix` naming the OPE ticket that removes it.";

export interface LegAudit {
  readonly reds: readonly string[];
  readonly live: ReadonlySet<string>;
  readonly passThroughSeen: ReadonlySet<string>;
}

export function auditLegReads(
  legs: readonly LegSource[],
  manifest: ReadonlyMap<string, DeclaredRead> = AMBIENT_READ_MANIFEST,
  passThrough: ReadonlyMap<string, string> = PASS_THROUGH,
): LegAudit {
  const reds: string[] = [];
  const live = new Set<string>();
  const passThroughSeen = new Set<string>();

  for (const leg of legs) {
    const use = envUseIn(leg.source);

    for (const [name, line] of [...use.reads].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (passThrough.has(name)) {
        passThroughSeen.add(name);
        continue;
      }
      if (use.dynamicPins.has(name)) continue;
      const key = declarationKey(leg.file, name);
      live.add(key);
      if (manifest.has(key)) continue;
      reds.push(
        `AMBIENT ENV READ: ${leg.file}:${line} reads process.env.${name}, which the suite never sets — ` +
          `so \`${leg.label}\` answers to the host, not to the code.`,
      );
    }

    if (use.aliasedEnv.length > 0) {
      reds.push(
        `ALIASED ENV ACCESS: ${leg.file}:${use.aliasedEnv[0]} reaches the environment under a name this gate ` +
          `cannot follow (\`env\` imported from node:process, or process["env"]). Everything here is anchored on ` +
          `the literal text \`process.env\`, so \`${leg.label}\` would be scanned as if it read nothing at all. ` +
          `Write the reads as \`process.env.<NAME>\`; there is no declaration for this one.`,
      );
    }

    const wholeKey = declarationKey(leg.file, WHOLE_ENV);
    if (use.wholeEnv.length > 0) {
      live.add(wholeKey);
      if (!manifest.has(wholeKey)) {
        const lines = [...new Set(use.wholeEnv)].sort((a, b) => a - b);
        reds.push(
          `AMBIENT WHOLE-ENV READ: ${leg.file} reads process.env as a whole value (line${lines.length > 1 ? "s" : ""} ` +
            `${lines.join(", ")}), so \`${leg.label}\` sees every variable the host happens to carry. A SPREAD ` +
            `(\`{ ...process.env }\`) is exempt wherever it appears, because that is how a suite builds a child ` +
            `process's env; this names the other shapes.`,
        );
      }
    }
  }

  return { reds, live, passThroughSeen };
}

export function auditManifestShape(
  audit: LegAudit,
  manifest: ReadonlyMap<string, DeclaredRead> = AMBIENT_READ_MANIFEST,
  passThrough: ReadonlyMap<string, string> = PASS_THROUGH,
): string[] {
  const reds: string[] = [];
  const { live, passThroughSeen } = audit;

  for (const [key, entry] of manifest) {
    if (!live.has(key)) {
      reds.push(
        `STALE AMBIENT DECLARATION: "${key}" is declared in scripts/ambient-env-manifest.ts, but no chain-leg ` +
          `suite makes that read any more — the file pins it now, stopped reading it, or was renamed. Delete the ` +
          `entry so the manifest keeps shrinking.`,
      );
      continue;
    }
    if (entry.why.trim().length < 20) {
      reds.push(
        `UNREASONED AMBIENT DECLARATION: "${key}" carries no real reason. The reason is the entry's whole ` +
          `justification — say what the host's value does to this suite and why that is safe.`,
      );
      continue;
    }
    if (entry.klass === "pending-fix" && !/OPE-\d+/.test(entry.why)) {
      reds.push(
        `UNTICKETED PENDING FIX: "${key}" is declared \`pending-fix\`, which means the dependence is real and ` +
          `someone will remove it — so the reason must name the OPE ticket that does. Name it, or reclassify.`,
      );
    }
  }

  for (const name of passThrough.keys()) {
    if (!passThroughSeen.has(name)) {
      reds.push(
        `STALE PASS-THROUGH: ${name} is exempt in PASS_THROUGH (scripts/ambient-env-manifest.ts) but no chain-leg ` +
          `suite reads it any more — delete the entry.`,
      );
    }
  }

  return reds;
}

export function auditAmbientReads(
  legs: readonly LegSource[],
  manifest: ReadonlyMap<string, DeclaredRead> = AMBIENT_READ_MANIFEST,
  passThrough: ReadonlyMap<string, string> = PASS_THROUGH,
): string[] {
  const audit = auditLegReads(legs, manifest, passThrough);
  return [...audit.reds, ...auditManifestShape(audit, manifest, passThrough)];
}
