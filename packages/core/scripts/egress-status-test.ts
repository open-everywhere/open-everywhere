import assert from "node:assert/strict";
import {
  EGRESS_README,
  EGRESS_README_PATH,
  EGRESS_STATUS_PATH,
  publishEgressStatus,
  renderEgressStatus,
  summariseEgressPolicy,
  type EgressStatusInput,
} from "../agent/access/egress-status.js";
import { PACKAGE_REGISTRY_HOSTS } from "../agent/access/bundle.js";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SECRET = "sk-oe-egress-status-canary-9f13";

const conn = (id: string): Connection =>
  ({ id, credentialType: "bearer", secretRef: "ACME_KEY", allowedWebsites: ["api.acme.test"] }) as unknown as Connection;

function access(hosts: ReachableHost[], connections: Connection[] = []): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "test/ws/surface",
    connections,
    connectorCredentials: {},
    reachableHosts: hosts,
    repos: [],
    repoCapabilities: {}, resourceCapabilities: {},
   
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    instructionStack: [], preApprovalRules: [],
    warnings: [],
  } as unknown as EffectiveAccess;
}

{
  const policy = {
    allow: {
      "api.acme.test": [
        { match: { method: ["GET"], path: { startsWith: "/v1/" } }, transform: [{ headers: { authorization: `Bearer ${SECRET}` } }] },
        { match: { method: ["POST"], path: { startsWith: "/v2/" } }, transform: [{ headers: { authorization: `Bearer ${SECRET}` } }] },
      ],
      "raw.githubusercontent.com": [],
    },
  } as never;

  const s = summariseEgressPolicy(policy);
  ok(s.defaultAction === "deny", "a compiled allow-map summarises as default-deny");
  ok(s.allow.length === 2, "every allowed host appears");
  ok(s.allow[0]!.host === "api.acme.test" && s.allow[1]!.host === "raw.githubusercontent.com", "hosts are sorted (deterministic bytes)");

  const acme = s.allow[0]!;
  ok(acme.methods?.join(",") === "GET,POST", "methods are UNIONED across the host's rules and sorted");
  ok(acme.pathPrefixes?.join(",") === "/v1/,/v2/", "path prefixes are unioned across the host's rules — the narrowing the agent actually meets");
  ok(acme.credentialInjected === true, "a header-bearing transform reduces to credentialInjected:true");

  const bare = s.allow[1]!;
  ok(bare.credentialInjected === false, "a bare allow reports credentialInjected:false");
  ok(bare.methods === undefined && bare.pathPrefixes === undefined && bare.paths === undefined, "an unnarrowed host omits the narrowing keys entirely rather than emitting empty arrays");

  const tokenHost = summariseEgressPolicy({
    allow: {
      "github.com": [
        { match: { method: ["GET"], path: { regex: "^/acme/bot\\.git/info/refs(\\?service=git-upload-pack)?$" } }, transform: [{ headers: { Authorization: "Basic X" } }] },
        { match: { method: ["POST"], path: { exact: "/acme/bot.git/git-upload-pack" } }, transform: [{ headers: { Authorization: "Basic X" } }] },
      ],
    },
  } as never).allow[0]!;
  ok(
    tokenHost.paths?.join(" ") === "/acme/bot.git/git-upload-pack ^/acme/bot\\.git/info/refs(\\?service=git-upload-pack)?$" && tokenHost.pathPrefixes === undefined,
    "🔴 OPE-2530: whole-path matchers reach STATUS.json as `paths`, so the token broker's narrowing is not reported as none",
  );
  ok(!JSON.stringify(tokenHost).includes("Basic X"), "…and the stamped credential never reaches the summary");

  const emptyTransform = summariseEgressPolicy({ allow: { "x.test": [{ transform: [] }] } } as never);
  ok(emptyTransform.allow[0]!.credentialInjected === false, "an EMPTY transform array is not a credential (that is the compiler's bare-allow shape)");

  const emptyHeaders = summariseEgressPolicy({ allow: { "x.test": [{ transform: [{ headers: {} }] }] } } as never);
  ok(emptyHeaders.allow[0]!.credentialInjected === true, "a transform ENTRY with no headers reads as a credential — an unrecognised shape never claims the firewall injected nothing");

  ok(summariseEgressPolicy("deny-all" as never).defaultAction === "deny" && summariseEgressPolicy("deny-all" as never).allow.length === 0, "deny-all summarises as default-deny with an empty list");
  ok(summariseEgressPolicy("allow-all" as never).defaultAction === "allow", "allow-all is reported honestly as allow — OE never compiles it, and hiding it would hide a bug");
}

{
  const policy = await compileNetworkPolicy(
    access([{ host: "api.acme.test", viaConnection: "acme", methods: ["GET"] }], [conn("acme")]),
    async () => ({ authorization: `Bearer ${SECRET}`, "x-acme-key": SECRET }),
    async (ids) => ids,
  );
  ok(JSON.stringify(policy).includes(SECRET), "PRECONDITION: the compiled policy really does carry the credential (otherwise this test proves nothing)");

  const bytes = renderEgressStatus({ policy, state: "enforced", fingerprint: "f".repeat(64), compileError: false });
  ok(!bytes.includes(SECRET), "🔴 the rendered status file does NOT contain the credential value");
  ok(!bytes.includes("authorization") && !bytes.includes("x-acme-key"), "…nor the header NAMES (a name is a hint about the scheme, and nothing in the file needs one)");
  ok(!bytes.includes("transform"), "…nor the transform structure at all");
  ok(bytes.includes("api.acme.test"), "…while the HOST is there, which is the point of the file");

  const parsed = JSON.parse(bytes) as { enforcement: string; defaultAction: string; policyFingerprint: string; compileError: boolean; allow: { host: string; credentialInjected: boolean }[] };
  ok(parsed.enforcement === "enforced" && parsed.defaultAction === "deny", "the parsed file states the enforcement state and the default action");
  ok(parsed.allow[0]!.credentialInjected === true, "…and still tells the agent a credential IS injected here, so it does not go hunting for a key");
  ok(parsed.policyFingerprint === "f".repeat(64), "…and carries the fingerprint, which is what ties it to the egress.policy audit row");
  ok(bytes.endsWith("\n"), "the file ends with a newline (it is read by shell tools)");

  const again = renderEgressStatus({ policy, state: "enforced", fingerprint: "f".repeat(64), compileError: false });
  ok(again === bytes, "rendering is DETERMINISTIC — no timestamp, no counter");

  const denied = JSON.parse(renderEgressStatus({ policy: "deny-all" as never, state: "enforced", fingerprint: "a".repeat(64), compileError: true })) as { compileError: boolean; allow: unknown[] };
  ok(denied.compileError === true && denied.allow.length === 0, "a fail-closed compile-error deny-all is labelled as such, with nothing reachable");
}

{
  const r = EGRESS_README;
  ok(/default-deny/i.test(r), "README states the policy: default-deny");
  ok(r.includes("STATUS.json"), "README points at the status file beside it");

  ok(/\*\*Do not retry it, and do not try to route around it\.\*\*/.test(r), "README says: do not retry, do not route around");
  ok(/policy, not an\s+outage/.test(r), "…and says WHY (policy, not an outage), because 'don't retry' without a reason is a rule an agent talks itself out of");
  ok(/\*\*Report it instead\*\*/.test(r), "README names the correct move: report it");

  ok(/`egress.policy` audit row carries the\s+`policyFingerprint`/.test(r), "README says what IS recorded: the policy, via the egress.policy row, keyed by the same fingerprint — which since OPE-314 is a key the row actually carries (hooks/egress.ts), not just a claim about one");
  ok(r.includes("permission_fit_report"), "README names the widening loop by tool name");

  ok(/\*\*the individual\s+blocked request\*\* is depends on the\s+tier/.test(r), "🔴 README makes the recorded/not-recorded answer depend on WHO OWNS THE FIREWALL, rather than asserting one tier's truth everywhere");
  ok(/`egress.denied` row/.test(r) && /host,\s+that fingerprint, a count, nothing else/.test(r), "🔴 README states what the self-host tier DOES record — and that it is host + fingerprint + count and nothing else, which is the minimisation invariant restated where the agent reads it");
  ok(/On the Vercel sandbox host the deny is out of band and no row exists at all/.test(r), "🔴 …and that the Vercel tier still records nothing, because we do not own that firewall");
  ok(!/egress denials are not among them/.test(r), "🔴 …and no longer carries the pre-OPE-314 blanket claim that permission_fit_report cannot see egress denials at all");
  ok(!/no automatic loop will ever notice it/.test(r), "🔴 …nor the 'no loop will ever notice' sentence it used to sit beside");
  ok(/only signal that always\s+exists/.test(r), "…which leaves the agent's own report load-bearing on BOTH tiers rather than a courtesy on one");

  ok(/reviewed pull request/.test(r), "README says widening is a reviewed PR (config-as-code), not something either side does at runtime");
  ok(r.includes("allowedWebsites") && r.includes("`domains`"), "…and names the two config fields that carry it");

  ok(/Never add an .Authorization. header yourself/.test(r), "README stops the agent trying to authenticate a call the firewall authenticates");
  ok(r.includes("`web_fetch` and `web_search` do not run in here"), "🔴 README scopes itself honestly: these tools run host-side, so this file is not the thing enforcing them");
  ok(/fenced against this\s+same allow-list/.test(r), "🔴 README states the CURRENT truth: web_fetch is fenced against this same allow-list before it dispatches");
  ok(/for its FIRST request only/.test(r) && /A redirect that `web_fetch` follows is NOT checked/.test(r), "🔴 …and bounds that claim to the first request: a redirect is not checked against the list (OPE-2688)");
  ok(!/does not mean .web_fetch. will fail/.test(r), "🔴 …and no longer carries the pre-fence claim that a host's absence says nothing about web_fetch");
  ok(/`web_search` runs\s+inside the model call and is bounded by neither/.test(r), "…while keeping the two tools apart: web_search really is bounded by neither plane");

  ok(/dry-run/.test(r) && /unenforced/.test(r), "README explains the two non-enforced states rather than leaving them cryptic");
  ok(/cannot use anyone's own account/.test(r), "🔴 README tells a shelling worker why an own-account host is missing from STATUS.json");
  ok(/not a config gap/.test(r), "…and that it is NOT a config gap, so the agent does not open a widening PR for it");
  ok(/## Three things/.test(r), "…and the section count matches what the section holds");
  ok(/rest of THAT turn the host can still be listed here/.test(r), "🔴 README bounds the refusal to the NEXT turn, so a still-listed host is not read as an own-account one");
  ok(/on the team key/.test(r), "…and names whose key that still-listed host carries");
  ok(r.length < 3500, `README stays a page an agent reads mid-task, not a manual chapter (${r.length} chars)`);
}

{
  const commands: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const sandbox = {
    run: async (o: { command: string }) => {
      commands.push(o.command);
    },
    writeTextFile: async (o: { path: string; content: string }) => {
      writes.push(o);
    },
  };
  const input: EgressStatusInput = {
    policy: { allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${SECRET}` } }] }] } } as never,
    state: "enforced",
    fingerprint: "b".repeat(64),
    compileError: false,
  };
  await publishEgressStatus(sandbox, input);

  ok(writes.length === 2, "both files are written");
  ok(writes[0]!.path === EGRESS_STATUS_PATH && writes[1]!.path === EGRESS_README_PATH, "…at the documented workspace-relative paths");
  ok(writes[0]!.path.startsWith("egress/") && !writes[0]!.path.startsWith("."), "the dir is top-level and unhidden — the consumer is an agent running `ls`");
  ok(writes.every((w) => !w.content.includes(SECRET)), "🔴 neither written file carries the credential");
  ok(writes[1]!.content === EGRESS_README, "the README written is the pinned one");

  ok(commands.length === 2, "the write is bracketed by exactly two shell calls");
  ok(/chmod -R u\+w 'egress'/.test(commands[0]!), "UNLOCK first — otherwise a later turn cannot refresh the dir it locked");
  ok(/chmod -R a-w 'egress'/.test(commands[1]!), "…and RE-LOCK after: this is the agent's own account of what it may reach, and a file it can rewrite is one it can talk itself into believing");
  ok(commands.every((c) => c.includes("|| true")), "both chmods tolerate failure — on the first publish the dir does not exist yet, and diagnostics must never break the turn");
}

{
  const { enforceEgress } = await import("../agent/hooks/egress.js");

  const SCOPE = { org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U7" };
  function rig(compile: () => Promise<unknown>) {
    const published: { state: string; fingerprint: string; bytes: string }[] = [];
    let fingerprint: string | undefined;
    let connectors: string | undefined;
    let failNext = false;
    let publishThrows = false;
    const deps = {
      resolve: () => access([{ host: "api.acme.test", viaConnection: "acme" }], [conn("acme")]),
      compile: compile as never,
      apply: async () => {
        if (failNext) throw new Error("sandbox.update blipped");
      },
      lastApplied: () => fingerprint,
      rememberApplied: (f: string) => {
        fingerprint = f;
      },
      lastConnectors: () => connectors,
      rememberConnectors: (c: string) => {
        connectors = c;
      },
      scope: () => SCOPE,
      audit: async () => {},
      stamp: () => {},
      publish: async (input: EgressStatusInput) => {
        if (publishThrows) throw new Error("writeTextFile blew up");
        published.push({ state: input.state, fingerprint: input.fingerprint, bytes: renderEgressStatus(input) });
      },
    };
    return {
      deps,
      published,
      breakApply: (v: boolean) => {
        failNext = v;
      },
      breakPublish: (v: boolean) => {
        publishThrows = v;
      },
    };
  }

  {
    let secret = SECRET;
    const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));

    await enforceEgress("session.started", r.deps as never);
    ok(r.published.length === 1, "session.started publishes the status surface");
    ok(r.published[0]!.state === "enforced", "…labelled enforced, because that is what this pass established");
    ok(!r.published[0]!.bytes.includes(SECRET), "🔴 end-to-end: the bytes that reach the sandbox carry no credential");

    await enforceEgress("turn.started", r.deps as never);
    ok(r.published.length === 1, "an UNCHANGED turn writes nothing — the surface rides the same skip-unchanged gate as the apply, so steady-state cost stays a compile");

    secret = "ROTATED-SECRET";
    await enforceEgress("turn.started", r.deps as never);
    ok(r.published.length === 2, "a CHANGED policy regenerates the file");
    ok(r.published[1]!.fingerprint !== r.published[0]!.fingerprint, "…under a new fingerprint, so a worker's report names the generation it actually met");
    ok(!r.published[1]!.bytes.includes("ROTATED-SECRET"), "🔴 …and the rotated credential is absent too (the regeneration is not a fresh leak path)");
  }

  {
    let secret = SECRET;
    const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
    await enforceEgress("session.started", r.deps as never);
    ok(r.published.length === 1, "baseline: the first apply published");
    secret = "ROTATED-AGAIN";
    r.breakApply(true);
    const failed = await enforceEgress("turn.started", r.deps as never);
    ok(failed.reason === "policy-changed" && failed.enforceError !== undefined, "PRECONDITION: the turn genuinely tried to re-apply a CHANGED policy, and that apply failed");
    ok(r.published.length === 1, "🔴 a turn whose apply THREW publishes NOTHING — the older file still describes what is actually in force");
  }

  {
    const r = rig(async () => ({ allow: { "api.acme.test": [] } }));
    r.breakPublish(true);
    const res = await enforceEgress("session.started", r.deps as never);
    ok(res.enforced === true && res.abortError === undefined, "a failed publish does NOT abort the session or undo the applied policy — diagnostics are best-effort by construction");
  }

  {
    overrideSettingsForTest({ egress: { enforce: false } });
    try {
      const r = rig(async () => ({ allow: { "api.acme.test": [] } }));
      await enforceEgress("session.started", r.deps as never);
      ok(r.published[0]?.state === "dry-run", "a dry-run deployment publishes state 'dry-run' — the list is what the operator INTENDS, and calling it enforced would be a security-relevant field lying");
    } finally {
      overrideSettingsForTest({ egress: { enforce: true } });
    }
  }
  {
    overrideSettingsForTest({ egress: { allowUnenforced: true } });
    try {
      const r = rig(async () => ({ allow: { "api.acme.test": [] } }));
      r.breakApply(true);
      await enforceEgress("session.started", r.deps as never);
      ok(r.published[0]?.state === "unenforced", "a backend that REFUSED the policy publishes state 'unenforced' — the agent in there is entitled to know nothing is enforcing");
    } finally {
      overrideSettingsForTest({ egress: { allowUnenforced: false } });
    }
  }
}

{
  ok(PACKAGE_REGISTRY_HOSTS.includes("registry.npmjs.org"), "the constant covers npm, which is the registry OE workers actually need (they run npm installs after a checkout)");
  ok(PACKAGE_REGISTRY_HOSTS.includes("files.pythonhosted.org") && PACKAGE_REGISTRY_HOSTS.includes("static.crates.io"), "…and each ecosystem's DOWNLOAD host, not just its index — an install that resolves but cannot fetch is still a broken install");
  ok(!PACKAGE_REGISTRY_HOSTS.some((h) => h === "*" || /^\*\.[^.]+$/u.test(h)), "no entry is a wildcard the bundle validator would reject as overly broad");
  ok(new Set(PACKAGE_REGISTRY_HOSTS).size === PACKAGE_REGISTRY_HOSTS.length, "no duplicates");

  const nothing = await compileNetworkPolicy(access([]), async () => ({}), async (ids) => ids);
  ok(nothing === "deny-all", "🔴 a scope granting nothing STILL compiles to deny-all — the registry set is opt-in, not a built-in widening");
}

console.log(`\n✓ egress-status: ${n} assertions passed (hosts-only status file + pinned README protocol + publish locking + hook-seam publish/skip + opt-in registry constant)\n`);

// proves: AP-MOD-core-access-egress-status
