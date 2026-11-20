import { EveDeepReadError, readEveInternalSource } from "./load.js";

/**
 * Deep read of `eve/dist/src/runtime/sessions/runtime-session.js`, as text.
 *
 * The built server bundle carries its own copy of eve. The fast prewarm reads the bundle's compiled
 * artifacts through `node_modules/eve`, so the two copies must share one runtime session. They do
 * because eve keeps that session on `globalThis` under a registered symbol. This read checks that the
 * symbol is still there.
 */
export const EVE_RUNTIME_SESSION_FILE = "runtime/sessions/runtime-session.js";

/** The registered symbol key that eve keeps its runtime session storage under. */
export const EVE_RUNTIME_SESSION_SYMBOL = "eve.runtime-session-storage";

const OWNER = "scripts/eve-deep-reads/runtime-session.ts";

/** Throws {@link EveDeepReadError} unless eve still keeps its runtime session on the global symbol. */
export function assertRuntimeSessionOnGlobalSymbol(root: string): void {
  const source = readEveInternalSource({ root, file: EVE_RUNTIME_SESSION_FILE, owner: OWNER });
  const forms = ["`", '"', "'"].map((q) => `Symbol.for(${q}${EVE_RUNTIME_SESSION_SYMBOL}${q})`);
  if (!forms.some((form) => source.includes(form))) {
    throw new EveDeepReadError({
      file: EVE_RUNTIME_SESSION_FILE,
      missing:
        `it no longer keeps the runtime session on Symbol.for("${EVE_RUNTIME_SESSION_SYMBOL}"), so the built bundle ` +
        "and node_modules/eve no longer share one session and the fast prewarm cannot read the bundle's artifacts",
      owner: OWNER,
    });
  }
}
