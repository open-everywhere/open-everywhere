// Reads an eve INTERNAL declaration file that a tripwire cites, on an eve that may not ship it.
//
// eve 1.0.1 publishes only the declarations its entry points reach (vercel/eve#6464), so about
// 1,800 internal `.d.ts` files left the tarball. Several tripwires cite eve's own contract prose
// from those files: "eve states X" is the finding, and the minified `.js` carries no comments.
//
// The rule here: while eve ships the declaration, the tripwire reads it. When eve does not, the
// citation stands only while the code it describes is the code the prose was read on. So every
// pruned declaration names that code and the value it had then:
//   - `module`: an eve module, pinned by the sha256 of its installed `.js`;
//   - `vendored`: a vendored library, pinned by its version in eve's `compiled/.vendor-stamp.json`.
// A changed module or version throws, and the message says what to do: read the declaration in the
// eve source at the new tag, re-run the cited checks by hand, then record the new value here.
//
// 🔴 The pin sees CODE, never prose. A change that edits only a declaration's comment, with the code
// unchanged, passes every pin, so a `says`/`saysNot` citation carried here can go stale in silence.
// So on every eve bump, re-read the cited declarations in the eve source at the new tag. Each one was
// last read in the eve 1.0.0 tarball, the last that ships them, where all are byte-identical to
// 1.0.0-rc.18, the tarball the tripwires were written against.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PrunedCode =
  | { readonly kind: "module"; readonly js: string; readonly sha256: string }
  | { readonly kind: "vendored"; readonly pkg: string; readonly version: string };

/** The last eve tarball that ships the cited declarations, where their prose was last read. */
export const PROSE_READ_ON = "1.0.0";

const WORKFLOW_CORE: PrunedCode = { kind: "vendored", pkg: "@workflow/core", version: "5.5.0" };
const WORKFLOW_WORLD: PrunedCode = { kind: "vendored", pkg: "@workflow/world", version: "5.2.0" };

/** Each cited declaration, relative to `dist/src`, and the code its prose describes. */
export const PRUNED_DECLARATIONS: Readonly<Record<string, PrunedCode>> = {
  "compiled/@workflow/world/queue.d.ts": WORKFLOW_WORLD,
  "compiled/@workflow/world/interfaces.d.ts": WORKFLOW_WORLD,
  "compiled/@workflow/world/spec-version.d.ts": WORKFLOW_WORLD,
  "compiled/@workflow/core/events-consumer.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/step-single-flight.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/spec8/step-ownership.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/spec9/step-single-flight.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/spec9/creator-rules.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/spec9/in-band-writer.d.ts": WORKFLOW_CORE,
  "compiled/@workflow/core/runtime/spec9/step-executor.d.ts": WORKFLOW_CORE,
  "compiled/@vercel/sandbox/sandbox.d.ts": { kind: "vendored", pkg: "@vercel/sandbox", version: "4.0.0" },
  "internal/workflow/spec-version-default.d.ts": {
    kind: "module",
    js: "internal/workflow/spec-version-default.js",
    sha256: "28053f4febaa6830597c2fee71a91c463f4e9383581ca63e8b695f32a7b351ca",
  },
  "execution/session/turn.d.ts": {
    kind: "module",
    js: "execution/session/turn.js",
    sha256: "670c3f2da3e6033f6a25a394d705db64409a894d8dfc1644eefd774967fa719d",
  },
  "execution/session/entry.d.ts": {
    kind: "module",
    js: "execution/session/entry.js",
    sha256: "fb3d540e02bc8bb59d7e90e70ddc4cd565b24fdca919c4f9bdf3fefd90760efc",
  },
  "execution/session/handoff.d.ts": {
    kind: "module",
    js: "execution/session/handoff.js",
    sha256: "8b23c141e3152a82da9dcae7878b8dd94154306c3439180675a349fa6e77c0e7",
  },
  "execution/workflow-host/turn-step.d.ts": {
    kind: "module",
    js: "execution/workflow-host/turn-step.js",
    sha256: "8e3a73675d921a1f86c25f86c9e2592b6d11bd494bb56fdaaab0607320c66bdf",
  },
  "execution/session/pre-v27-checkpoint.d.ts": {
    kind: "module",
    js: "execution/session/pre-v27-checkpoint.js",
    sha256: "4f99680a11bef9fd10c20d6fc99e8756b83f185bbb25be28870a73e832306e15",
  },
  "harness/hitl/approved-calls.d.ts": {
    kind: "module",
    js: "harness/hitl/approved-calls.js",
    sha256: "2045b947804976992614f59ecdd3fde597b86584de45e36b93ee50ab35217dd0",
  },
};

/** Why the pinned code no longer matches, or undefined when it still does. */
export function prunedCodeDrift(distSrc: string, code: PrunedCode): string | undefined {
  if (code.kind === "module") {
    const path = join(distSrc, code.js);
    if (!existsSync(path)) return `${code.js} is gone`;
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    return actual === code.sha256 ? undefined : `${code.js} changed (sha256 ${actual}, the prose was read on ${code.sha256})`;
  }
  const stampPath = join(distSrc, "compiled", ".vendor-stamp.json");
  const stamp = existsSync(stampPath) ? (JSON.parse(readFileSync(stampPath, "utf8")) as { moduleVersions?: Record<string, string> }) : {};
  const actual = stamp.moduleVersions?.[code.pkg];
  return actual === code.version ? undefined : `vendored ${code.pkg} is ${actual ?? "absent"}, the prose was read on ${code.version}`;
}

export type CitedDeclaration =
  | { readonly shipped: true; readonly text: string }
  | { readonly shipped: false; readonly carriedBy: PrunedCode };

/**
 * The declaration text while eve ships it. Otherwise the identity pin that carries its citations,
 * after the pin is checked: a drifted pin throws. A prose-only change with unchanged code is not
 * visible here (see the header), so a carried citation is as fresh as the last read at the tag.
 */
export function citedDeclaration(distSrc: string, rel: string): CitedDeclaration {
  const path = join(distSrc, rel);
  if (existsSync(path)) return { shipped: true, text: readFileSync(path, "utf8") };
  const code = PRUNED_DECLARATIONS[rel];
  if (code === undefined) {
    throw new Error(
      `eve no longer ships ${rel}, and _eve-pruned-declaration.ts names no code that carries its citations. ` +
        "Read the declaration in the eve source at the installed tag, find the module or vendored library it describes, and add an entry.",
    );
  }
  const drift = prunedCodeDrift(distSrc, code);
  if (drift !== undefined) {
    throw new Error(
      `eve no longer ships ${rel}, and the code its prose describes moved: ${drift}. ` +
        `The citations were read on eve ${PROSE_READ_ON}. Read the declaration in the eve source at the installed tag, ` +
        "re-check every citation the tripwire makes from it, then record the new value in _eve-pruned-declaration.ts.",
    );
  }
  return { shipped: false, carriedBy: code };
}
