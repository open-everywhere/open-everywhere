import assert from "node:assert/strict";
import {
  currentTurnEntityRef,
  resolveEntityAction,
  entityActionFn,
  registerEntityActionAdapter,
  supportedEntityActionPlatforms,
  type EntityActionAdapter,
} from "../agent/channels/entity-actions.js";
import { registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function ctx(platform: string, attrs: Record<string, string> = {}): BindableContext {
  return { channel: { kind: platform }, session: { auth: { current: { attributes: attrs } } } } as unknown as BindableContext;
}

const WORK_ROLE = "project-key";
const grantedPlatforms = new Set<string>();
function grantFor(platform: string): readonly Domain[] {
  if (!grantedPlatforms.has(platform)) {
    registerIdentityMapper(platform, () => ({ workspace: "W1", surface: platform, mode: "channel", visibility: "public", trust: "internal", principalId: "U_TEST" }));
    grantedPlatforms.add(platform);
  }
  return [
    defineDomain({
      name: `d-${platform}`,
      reach: [`${platform}/W1/${platform}`],
      credentials: [{ connector: platform, credential: WORK_ROLE, use: `${platform}-key` }],
    }),
  ];
}

{
  const linear = currentTurnEntityRef(ctx("linear", { issue_id: "abc-123" }));
  ok(linear?.platform === "linear" && linear.id === "abc-123", "Linear: default ref reads the issue_id auth attribute");
  ok(linear?.organizationId === undefined, "NEGATIVE CONTROL: no organization_id stamped ⇒ the ref carries NO organizationId key (byte-identical to before OPE-882)");

  const linearOrg = currentTurnEntityRef(ctx("linear", { issue_id: "abc-123", organization_id: "org-soak" }));
  ok(linearOrg?.platform === "linear" && linearOrg.id === "abc-123" && linearOrg.organizationId === "org-soak", "🔴 THE FIX: a Linear ref carries organizationId off the turn's organization_id auth attribute");

  ok(currentTurnEntityRef(ctx("linear", {})) === undefined, "Linear: no issue_id stamped ⇒ no default (never guesses)");

  const gh = currentTurnEntityRef(ctx("github", { owner: "acme", repo: "web", issue_number: "42" }));
  ok(gh?.platform === "github" && gh.id === "acme/web#42", "GitHub: default ref composes owner/repo#issueNumber");

  const ghPr = currentTurnEntityRef(ctx("github", { owner: "acme", repo: "web", pull_request_number: "7" }));
  ok(ghPr?.id === "acme/web#7", "GitHub: a PR anchor composes owner/repo#pullRequestNumber");

  ok(currentTurnEntityRef(ctx("github", { owner: "acme" })) === undefined, "GitHub: missing repo/number ⇒ no default");
  ok(currentTurnEntityRef(ctx("slack", {})) === undefined, "Slack (chat): no entity concept ⇒ always undefined");
  ok(currentTurnEntityRef(ctx("notion", {})) === undefined, "Notion: no entity-actions mapping ⇒ always undefined");
}

{
  await assert.rejects(() => resolveEntityAction(ctx("slack", {}), "setState", undefined, []), /no ticket entity for this turn/, "no ref + no default entity refuses cleanly");
  n++;
}

{
  await assert.rejects(
    () => resolveEntityAction(ctx("slack", {}), "setState", { platform: "linear", id: "ENG-1" }, []),
    /not one of this session's work destinations/,
    "a ref naming a platform this session may not address is refused (the entity gate)",
  );
  n++;
}

{
  await assert.rejects(
    () => resolveEntityAction(ctx("notion", {}), "addLabel", { platform: "notion", id: "page-1" }, grantFor("notion")),
    /not one of this session's work destinations/,
    "a platform with NO registered work adapter is refused at the destination gate, even by a domain that declares its work role",
  );
  n++;
}

{
  const readOnlyAdapter: EntityActionAdapter = { platform: "test-verb-partial", workRole: WORK_ROLE, setState: async (id, v) => `set:${id}:${v}` };
  registerEntityActionAdapter(readOnlyAdapter);
  const { ref } = await resolveEntityAction(ctx("test-verb-partial", {}), "setState", { platform: "test-verb-partial", id: "1" }, grantFor("test-verb-partial"));
  ok(ref.id === "1", "a verb the adapter DOES implement resolves fine");
  await assert.rejects(
    () => resolveEntityAction(ctx("test-verb-partial", {}), "addLabel", { platform: "test-verb-partial", id: "1" }, grantFor("test-verb-partial")),
    /addLabel is not supported on "test-verb-partial"/,
    "a registered platform missing THIS verb refuses (per-verb entity gating, not per-platform)",
  );
  n++;
  try {
    await resolveEntityAction(ctx("test-verb-partial", {}), "addLabel", { platform: "test-verb-partial", id: "1" }, grantFor("test-verb-partial"));
    assert.fail("expected a throw");
  } catch (err) {
    ok(String((err as Error).message).includes("github"), "the refusal names the platforms that DO support addLabel (github in core alone)");
  }
}

{
  const gatedAdapter: EntityActionAdapter = {
    platform: "test-checked",
    workRole: WORK_ROLE,
    checkAccess: (_c, id) => {
      if (id === "forbidden") throw new Error("nope, not granted");
    },
    assign: async (id, v) => `assigned:${id}:${v}`,
  };
  registerEntityActionAdapter(gatedAdapter);
  await assert.rejects(
    () => resolveEntityAction(ctx("test-checked", {}), "assign", { platform: "test-checked", id: "forbidden" }, grantFor("test-checked")),
    /nope, not granted/,
    "checkAccess's refusal propagates from resolveEntityAction",
  );
  n++;
  const { ref, run } = await resolveEntityAction(ctx("test-checked", {}), "assign", { platform: "test-checked", id: "ok-id" }, grantFor("test-checked"));
  ok(ref.id === "ok-id", "checkAccess passing lets resolution through");
  const outcome = await run("alice");
  ok(outcome === "assigned:ok-id:alice", "the bound `run` closure calls the adapter fn with (entityId, value)");
}

{
  let seenOrg: string | undefined = "never called";
  registerEntityActionAdapter({
    platform: "test-org-threading",
    workRole: WORK_ROLE,
    assign: async (id, v, organizationId) => {
      seenOrg = organizationId;
      return `assigned:${id}:${v}:${organizationId ?? "(none)"}`;
    },
  });
  const { run } = await resolveEntityAction(ctx("test-org-threading", {}), "assign", { platform: "test-org-threading", id: "1", organizationId: "org-soak" }, grantFor("test-org-threading"));
  const outcome = await run("bob");
  ok(outcome === "assigned:1:bob:org-soak", `🔴 THE FIX: run() passes the explicit ref.organizationId through to the adapter fn as a third argument (got "${outcome}")`);
  ok(seenOrg === "org-soak", "…and the adapter fn actually received it");

  const { run: runNoOrg } = await resolveEntityAction(ctx("test-org-threading", {}), "assign", { platform: "test-org-threading", id: "1" }, grantFor("test-org-threading"));
  seenOrg = "never called";
  await runNoOrg("bob");
  ok(seenOrg === undefined, "NEGATIVE CONTROL: a ref with no organizationId passes undefined through — never invents one");
}

{
  let consulted = 0;
  registerEntityActionAdapter({
    platform: "test-async-checked",
    workRole: WORK_ROLE,
    checkAccess: async (_c, id) => {
      consulted++;
      if (id === "forbidden") throw new Error("async refusal from checkAccess");
    },
    assign: async (id, v) => `assigned:${id}:${v}`,
  });
  await assert.rejects(
    () => resolveEntityAction(ctx("test-async-checked", {}), "assign", { platform: "test-async-checked", id: "forbidden" }, grantFor("test-async-checked")),
    /async refusal from checkAccess/,
    "an ASYNC checkAccess's rejection propagates — resolveEntityAction awaits it, so a refusal cannot float away unnoticed",
  );
  ok(consulted === 1, "…and the hook was actually consulted, not skipped");
  n++;
  const okRes = await resolveEntityAction(ctx("test-async-checked", {}), "assign", { platform: "test-async-checked", id: "fine" }, grantFor("test-async-checked"));
  ok(okRes.ref.id === "fine" && consulted === 2, "an async checkAccess that resolves lets resolution through");
}

{
  let seen: unknown = "never called";
  registerEntityActionAdapter({
    platform: "test-domains-arg",
    workRole: WORK_ROLE,
    checkAccess: (_c, _id, domains) => void (seen = domains),
    setState: async () => "ok",
  });
  const marker = [...grantFor("test-domains-arg"), { name: "marker-domain" }] as unknown as Parameters<typeof resolveEntityAction>[3];
  await resolveEntityAction(ctx("test-domains-arg", {}), "setState", { platform: "test-domains-arg", id: "1" }, marker);
  ok(
    Array.isArray(seen) && (seen as { name: string }[]).some((d) => d.name === "marker-domain"),
    "the `domains` the resolver was given is handed to checkAccess unchanged",
  );
  n++;
}

{
  ok(typeof entityActionFn("github", "setState") === "function", "entityActionFn resolves a real registered adapter's fn");
  ok(entityActionFn("bogus-platform", "setState") === undefined, "entityActionFn is undefined for an unregistered platform");
  ok(entityActionFn("test-verb-partial", "addLabel") === undefined, "entityActionFn is undefined for a verb the platform doesn't implement");
}

{
  const platforms = supportedEntityActionPlatforms();
  ok(platforms.includes("github"), "github is registered (module-load side effect)");
  ok(!platforms.includes("linear"), "linear is NOT registered in core alone (its adapter is bundle-registered at boot)");
  ok(!platforms.includes("notion"), "notion is NOT registered — no sane status/label mapping exists (design doc decision)");
  ok(typeof entityActionFn("github", "setState") === "function", "github declares setState");
  ok(typeof entityActionFn("github", "assign") === "function", "github declares assign");
  ok(typeof entityActionFn("github", "addLabel") === "function", "github declares addLabel");
}

console.log(`✓ ${n} entity-actions assertions passed`);
