import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitGrantsModule,
  emptyGrantsFile,
  parseGrantsModule,
  renormalizeGrantsModule,
} from "@open-everywhere/core/agent/access/grants-codemod.js";
import {
  emitCredentialBindingsModule,
  emptyCredentialBindingsFile,
  parseCredentialBindingsModule,
  renormalizeCredentialBindingsModule,
} from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";
import {
  emitHooksModule,
  emptyHooksFile,
  parseHooksModule,
  renormalizeHooksModule,
} from "@open-everywhere/core/agent/webhooks/hooks-codemod.js";
import {
  emitAgentsModule,
  emptyAgentsFile,
  parseAgentsModule,
  renormalizeAgentsModule,
} from "@open-everywhere/core/agent/memory/agents-codemod.js";
import {
  emitGroupsModule,
  emptyGroupsFile,
  parseGroupsModule,
  renormalizeGroupsModule,
} from "@open-everywhere/core/agent/identity/groups-codemod.js";

interface OverlaySpec {
  readonly path: string;
  readonly what: string;
  readonly flow: string;
  readonly parseModule: (text: string) => unknown;
  readonly renormalize: (text: string) => string;
  readonly emitEmpty: () => string;
}

const OVERLAYS: readonly OverlaySpec[] = [
  {
    path: "agent/access/grants.generated.ts",
    what: "grants overlay",
    flow: "request_access (access/grants-codemod.ts)",
    parseModule: parseGrantsModule,
    renormalize: renormalizeGrantsModule,
    emitEmpty: () => emitGrantsModule(emptyGrantsFile()),
  },
  {
    path: "agent/access/credential-bindings.generated.ts",
    what: "credential-bindings overlay",
    flow: "credential binding (access/credential-bindings-codemod.ts)",
    parseModule: parseCredentialBindingsModule,
    renormalize: renormalizeCredentialBindingsModule,
    emitEmpty: () => emitCredentialBindingsModule(emptyCredentialBindingsFile()),
  },
  {
    path: "agent/webhooks/hooks.generated.ts",
    what: "webhook-hooks overlay",
    flow: "declare_webhook (webhooks/hooks-codemod.ts)",
    parseModule: parseHooksModule,
    renormalize: renormalizeHooksModule,
    emitEmpty: () => emitHooksModule(emptyHooksFile()),
  },
  {
    path: "agent/memory/config/agents.generated.ts",
    what: "agents overlay",
    flow: "create_agent (memory/agents-codemod.ts)",
    parseModule: parseAgentsModule,
    renormalize: renormalizeAgentsModule,
    emitEmpty: () => emitAgentsModule(emptyAgentsFile()),
  },
  {
    path: "agent/identity/groups.generated.ts",
    what: "person-groups overlay",
    flow: "directory_groups_plan (identity/groups-codemod.ts)",
    parseModule: parseGroupsModule,
    renormalize: renormalizeGroupsModule,
    emitEmpty: () => emitGroupsModule(emptyGroupsFile()),
  },
];

const rootFlagAt = process.argv.indexOf("--root");
const root =
  rootFlagAt >= 0 && process.argv[rootFlagAt + 1] !== undefined
    ? process.argv[rootFlagAt + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const problems: string[] = [];
const wrote: string[] = [];

for (const spec of OVERLAYS) {
  const abs = join(root, spec.path);

  if (!existsSync(abs)) {
    if (check) problems.push(`${spec.path} is MISSING — the ${spec.what} loader imports it statically, so its absence breaks the build (${spec.flow})`);
    else {
      writeFileSync(abs, spec.emitEmpty());
      wrote.push(spec.path);
    }
    continue;
  }

  const text = readFileSync(abs, "utf8");

  if (check) {
    try {
      spec.parseModule(text);
    } catch (err) {
      problems.push(`${spec.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    continue;
  }

  let next: string;
  try {
    next = spec.renormalize(text);
  } catch (err) {
    problems.push(`${spec.path}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (next !== text) {
    writeFileSync(abs, next);
    wrote.push(spec.path);
  }
}

const EVE_MEMORY_SLOT_DIR = "agent/memory";
const AUTHORED_EVE_MEMORY_SLOTS: readonly string[] = [];
if (existsSync(join(root, EVE_MEMORY_SLOT_DIR))) {
  const strays = readdirSync(join(root, EVE_MEMORY_SLOT_DIR), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:ts|mts|js|mjs)$/u.test(e.name))
    .map((e) => e.name)
    .filter((name) => !AUTHORED_EVE_MEMORY_SLOTS.includes(name));
  if (strays.length > 0) {
    problems.push(
      `${EVE_MEMORY_SLOT_DIR}/ holds ${strays.length} module(s) eve will read as authored memory slots: ${strays.join(", ")}. ` +
        `eve discovers every module directly inside that directory and requires a \`defineMemory()\` default export, so ` +
        `the build fails with "Expected the memory export …". OE's memory CONFIGURATION belongs in ` +
        `${EVE_MEMORY_SLOT_DIR}/config/ (eve's scan is not recursive); only a real memory provider belongs here, and it ` +
        `must be listed in AUTHORED_EVE_MEMORY_SLOTS in this file.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`✗ machine-owned config overlays (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    check
      ? "  These files are MACHINE-OWNED data modules. Edit only the data, then run: npm run overlays:normalize"
      : "  Fix the reported file(s) by hand — normalisation can re-format data, it cannot remove code or repair a broken shape.",
  );
  process.exit(1);
}

if (check) {
  console.log(`✓ config overlays are canonical data — ${OVERLAYS.length} machine-owned module(s) re-emit byte-identically (no hand-edit, no executable code)`);
} else {
  console.log(wrote.length === 0 ? `✓ config overlays already canonical (${OVERLAYS.length} checked)` : `✓ normalised ${wrote.length} overlay(s): ${wrote.join(", ")}`);
}
