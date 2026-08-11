import { gatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { STACKS, STACK_ALIASES, type ModelRole, type StackAlias } from "../agent/model/stacks.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const wantRates = args.includes("--rates");

const RED_32 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

interface VisionFixture {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly expectAny: readonly string[];
  readonly maxChars: number;
  readonly trials: number;
}

const VISION_FIXTURES: readonly VisionFixture[] = [
  {
    label: "red-32x32 (F-ART fixture)",
    bytes: RED_32,
    mimeType: "image/png",
    expectAny: ["red"],
    maxChars: 120,
    trials: 3,
  },
];

interface Row {
  readonly inTokens: number;
  readonly outTokens: number;
  readonly cost: number;
}

let failures = 0;

function costOf(meta: unknown): number {
  const g = (meta as Record<string, Record<string, unknown>> | undefined)?.["gateway"];
  const c = g?.["cost"];
  return typeof c === "number" ? c : typeof c === "string" ? Number(c) : Number.NaN;
}

function providerOf(meta: unknown): string {
  const g = (meta as Record<string, Record<string, unknown>> | undefined)?.["gateway"];
  const routing = g?.["routing"] as Record<string, unknown> | undefined;
  const p = routing?.["resolvedProvider"];
  return typeof p === "string" ? p : "unknown";
}

function filler(words: number, salt: string): string {
  return Array.from({ length: words }, (_, i) => `${salt}${i}`).join(" ");
}

async function textProbe(id: string): Promise<void> {
  const { gateway, generateText } = await import("ai");
  try {
    const r = await generateText({
      model: gateway(id),
      maxOutputTokens: 32,
      prompt: "Reply with exactly the word: ready.",
    });
    const ok = r.text.toLowerCase().includes("ready");
    console.log(`    text      ${ok ? "✓" : "⚠"} ${JSON.stringify(r.text.slice(0, 60))} (provider ${providerOf(r.providerMetadata)})`);
    if (!ok) console.log(`               (routed, but did not follow a trivial instruction — usable, worth noting)`);
  } catch (err) {
    failures++;
    console.log(`    text      ✗ ${err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err)}`);
  }
}

async function visionProbe(id: string): Promise<void> {
  const describer = gatewayImageDescriber({ id });
  for (const fx of VISION_FIXTURES) {
    let correct = 0;
    const seen: string[] = [];
    for (let t = 0; t < fx.trials; t++) {
      try {
        const r = await describer.describe({ bytes: fx.bytes, mimeType: fx.mimeType });
        const d = r.description.toLowerCase();
        if (fx.expectAny.some((w) => d.includes(w)) && r.description.length <= fx.maxChars) correct++;
        seen.push(r.description.slice(0, 70));
      } catch (err) {
        seen.push(`THROW ${err instanceof Error ? err.message.slice(0, 70) : String(err)}`);
      }
    }
    const ok = correct === fx.trials;
    if (!ok) failures++;
    console.log(`    vision    ${ok ? "✓" : "✗"} ${fx.label}: ${correct}/${fx.trials} correct`);
    if (!ok) {
      for (const s of seen) console.log(`               • ${JSON.stringify(s)}`);
      console.log(
        `               A WRONG ANSWER HERE IS NOT A DEGRADE. describe_image is fail-closed on a` +
          ` throw, so an unroutable model is safe; a model that answers confidently about an image` +
          ` it did not receive defeats the contract. Do not ship this id in a vision role.`,
      );
    }
  }
}

async function rateProbe(id: string): Promise<void> {
  const { gateway, generateText } = await import("ai");
  const call = async (words: number, maxOut: number, ask: string): Promise<Row & { provider: string }> => {
    const r = await generateText({
      model: gateway(id),
      maxOutputTokens: maxOut,
      prompt: `${filler(words, Math.random().toString(36).slice(2, 8))}\n\nIgnore the tokens above. ${ask}`,
    });
    return {
      inTokens: r.usage.inputTokens ?? 0,
      outTokens: r.usage.outputTokens ?? 0,
      cost: costOf(r.providerMetadata),
      provider: providerOf(r.providerMetadata),
    };
  };
  try {
    const a = await call(6000, 16, "Reply with the single word: blue.");
    const b = await call(6000, 900, "Write a 700-word essay about the colour blue.");
    const c = await call(600, 900, "Write a 700-word essay about the colour green.");
    const det = a.inTokens * b.outTokens - b.inTokens * a.outTokens;
    if (Math.abs(det) < 1e-9) {
      console.log(`    rates     ⚠ degenerate sweep (in/out ratios too close to separate)`);
      return;
    }
    const x = (a.cost * b.outTokens - b.cost * a.outTokens) / det;
    const y = (b.cost * a.inTokens - a.cost * b.inTokens) / det;
    const predicted = c.inTokens * x + c.outTokens * y;
    const err = Math.abs((predicted - c.cost) / c.cost);
    console.log(
      `    rates     ${err < 0.03 ? "✓" : "⚠"} in $${(x * 1e6).toFixed(4)}/Mtok  out $${(y * 1e6).toFixed(4)}/Mtok ` +
        `(held-out row off by ${(err * 100).toFixed(2)}%; providers ${[a.provider, b.provider, c.provider].join("/")})`,
    );
    if (err >= 0.03) {
      console.log(
        `               NOT ONE RATE. A held-out row this far off means the gateway served these calls` +
          ` from upstreams that charge differently — quote a BAND for this id, not a number, and do not` +
          ` put a single value in spend/pricing.ts's BUILT_IN table for it.`,
      );
    }
  } catch (err) {
    console.log(`    rates     ✗ ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
}

async function probeId(id: string, roles: readonly string[]): Promise<void> {
  console.log(`\n  ${id}  [${roles.join(", ")}]`);
  await textProbe(id);
  if (roles.includes("vision")) await visionProbe(id);
  if (wantRates) await rateProbe(id);
}

async function main(): Promise<void> {
  const adHoc = flag("id");
  if (adHoc !== undefined) {
    console.log(`Probing ad-hoc id through this deployment's own transport.`);
    await probeId(adHoc, ["ad-hoc", "vision"]);
  } else {
    const only = flag("stack");
    if (only !== undefined && !STACK_ALIASES.includes(only as StackAlias)) {
      console.error(`✗ unknown stack "${only}" — shipped: ${STACK_ALIASES.join(", ")}`);
      process.exit(2);
    }
    const aliases = only !== undefined ? [only as StackAlias] : STACK_ALIASES;
    for (const alias of aliases) {
      console.log(`\n═══ stack "${alias}" ═══`);
      const byId = new Map<string, ModelRole[]>();
      for (const [role, spec] of Object.entries(STACKS[alias]) as [ModelRole, { id: string }][]) {
        byId.set(spec.id, [...(byId.get(spec.id) ?? []), role]);
      }
      for (const [id, roles] of byId) await probeId(id, roles);
    }
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} probe failure(s). An id that fails here must not ship in that role.`);
    process.exit(1);
  }
  console.log(`\n✓ every probed id routes through this deployment's own transport and answers its role's fixtures.`);
}

main().catch((err) => {
  console.error("✗ model-route-probe crashed:", err);
  process.exit(1);
});
