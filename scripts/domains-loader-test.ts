import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { assembleDomains, loadDomainModules, type DomainModule } from "../agent/memory/config/domains/index.js";
import { loadDomains } from "../agent/memory/config/domains.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
};
const throws = (fn: () => unknown, needle: string, label: string): void => {
  let msg = "";
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg.includes(needle), `${label} (wanted "${needle}" in: ${msg || "<no throw>"})`);
};

{
  const alpha: DomainModule = { domain: defineDomain({ name: "alpha", reach: ["slack/T1/C1"] }) };
  const alphaAgain: DomainModule = { domain: defineDomain({ name: "alpha", reach: ["slack/T1/C2"] }) };
  const beta: DomainModule = { domain: defineDomain({ name: "beta", reach: ["slack/T1/C3"] }) };

  throws(() => assembleDomains([alpha, beta, alphaAgain]), 'two domain modules declare the name "alpha"', "two modules under one name are refused");
  throws(() => assembleDomains([alpha, beta, alphaAgain]), "entries 0 and 2", "…and the refusal names BOTH entries, so the duplicate is one edit away from fixed");

  const renamed: DomainModule = { domain: defineDomain({ name: "alpha-2", reach: ["slack/T1/C2"] }) };
  const assembled = assembleDomains([alpha, beta, renamed]);
  ok(assembled.length === 3, "three distinctly-named modules assemble to three domains");
  ok(assembled.map((d) => d.name).join(",") === "alpha,beta,alpha-2", "…in declaration order, which is what a reader of index.ts sees");
}

{
  const on: DomainModule = { domain: defineDomain({ name: "gated", reach: ["slack/T1/C1"] }), enabled: () => true };
  const off: DomainModule = { domain: defineDomain({ name: "gated", reach: ["slack/T1/C2"] }), enabled: () => false };
  const always: DomainModule = { domain: defineDomain({ name: "plain", reach: ["slack/T1/C3"] }) };

  const withOff = assembleDomains([on, off, always]);
  ok(withOff.length === 2, "a module whose enabled() is false is not registered");
  ok(withOff.some((d) => d.name === "gated"), "…and the ENABLED module of that name still is");
  ok(withOff.map((d) => d.reach?.[0]).join(",") === "slack/T1/C1,slack/T1/C3", "…so the pair swaps by flag rather than colliding on the name");

  const flipped = assembleDomains([{ ...on, enabled: () => false }, { ...off, enabled: () => true }, always]);
  ok(flipped.map((d) => d.reach?.[0]).join(",") === "slack/T1/C2,slack/T1/C3", "the OTHER copy registers when the flags flip");

  ok(assembleDomains([always]).length === 1, "a module with no enabled() is always registered");
}

{
  const modules = loadDomainModules();
  ok(modules.length > 0, "the deployment's own modules assemble");
  const names = modules.map((d) => d.name);
  ok(new Set(names).size === names.length, "every registered domain name is unique");

  for (const d of modules) {
    const hasReach = d.reach !== undefined;
    const hasMatch = d.match !== undefined;
    ok(hasReach !== hasMatch, `"${d.name}" has reach XOR match`);
  }

  const exported = loadDomains().map((d) => d.name);
  for (const name of names) ok(exported.includes(name), `"${name}" reaches the exported registry`);
}

console.log(`\n✓ domains-loader: ${n} assertions passed (OPE-254 one file per domain — the duplicate-name refusal, the enabled() gate, and the deployment's own set)\n`);
