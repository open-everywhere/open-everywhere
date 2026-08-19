import assert from "node:assert/strict";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

const realFetch = globalThis.fetch;

{
  const fake = (async () => new Response("stub", { status: 200 })) as unknown as typeof fetch;
  let sawStubInside = false;
  const res = await withPatchedFetch(fake, async () => {
    sawStubInside = globalThis.fetch === fake;
    return await (await globalThis.fetch("https://example.test")).text();
  });
  ok(sawStubInside, "withPatchedFetch: globalThis.fetch is the fake WHILE fn runs");
  ok(res === "stub", "withPatchedFetch: fn observes the fake's response");
  ok(globalThis.fetch === realFetch, "withPatchedFetch: globalThis.fetch is restored after fn RESOLVES (success path)");
}

{
  const fake = (async () => new Response("stub", { status: 200 })) as unknown as typeof fetch;
  let threw: unknown;
  try {
    await withPatchedFetch(fake, async () => {
      ok(globalThis.fetch === fake, "withPatchedFetch: the fake is installed on the throwing path too, before the throw");
      throw new Error("simulated assertion failure mid-block");
    });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error && /simulated assertion failure/.test(threw.message), "withPatchedFetch: the thrown error propagates to the caller (never swallowed)");
  ok(globalThis.fetch === realFetch, "🔴 withPatchedFetch: globalThis.fetch is restored even though fn THREW — the leak this ticket closes");
}

{
  const outerFake = (async () => new Response("outer", { status: 200 })) as unknown as typeof fetch;
  const innerFake = (async () => new Response("inner", { status: 200 })) as unknown as typeof fetch;
  await withPatchedFetch(outerFake, async () => {
    ok(globalThis.fetch === outerFake, "nesting: outer fake live before the inner call");
    await withPatchedFetch(innerFake, async () => {
      ok(globalThis.fetch === innerFake, "nesting: inner fake live inside the inner call");
    });
    ok(globalThis.fetch === outerFake, "nesting: outer fake restored once the inner call returns");
  });
  ok(globalThis.fetch === realFetch, "nesting: real fetch restored once the outer call returns");
}

ok(globalThis.fetch === realFetch, "end of file: globalThis.fetch is the real one — this suite leaves nothing behind for its shard-mates");
console.log(`✓ fetch-test-utils: ${passed} assertions passed`);
