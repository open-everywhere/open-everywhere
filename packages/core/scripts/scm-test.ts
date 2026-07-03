import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { parsePrivateKey, signAppJwt, buildMintBody, mintInstallationToken, DEFAULT_PERMISSIONS, normalizePrivateKeyPem, type FetchFn } from "../agent/scm/mint.js";
import { authExtraHeader, cloneArgs, fetchArgs, pushArgs, botCommitter, identityArgs, checkoutCommand, isSafeCheckoutDir, redactSecret, CHECKOUT_OK, conventionProbe, parseConventionProbe, CONV_MARKER, CONVENTION_FILES, skillsProbe, parseSkillsProbe, SKILL_MARKER, SKILL_TRUNC_MARKER, SKILL_ROOTS, MAX_REPO_SKILLS, MAX_SKILL_BYTES, agentsProbe, parseAgentsProbe, AGENT_MARKER, AGENT_TRUNC_MARKER, AGENT_ROOTS, MAX_REPO_AGENTS } from "../agent/scm/git.js";
import { repoSlug, mergeRepoSkills, isSafeSkillName, parseRepoAgent, delegationHeader, REPO_SKILL_SEP, type RepoSkillsEntry } from "../agent/scm/repo-skills.js";
import { loadGitHubAppConfig } from "../agent/scm/config.js";
import { GitHubApp } from "../agent/scm/app.js";
import { repoAllowed } from "../agent/scm/provider.js";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

{
  ok(pkcs1.includes("BEGIN RSA PRIVATE KEY"), "fixture exports a PKCS#1 key (GitHub's format)");
  ok(!!parsePrivateKey(pkcs1), "parsePrivateKey accepts PKCS#1");
  ok(!!parsePrivateKey(pkcs8), "parsePrivateKey accepts PKCS#8");
}

{
  const now = 1_750_000_000;
  const jwt = await signAppJwt(parsePrivateKey(pkcs1), "Iv1.clientid", now);
  const { payload, protectedHeader } = await jwtVerify(jwt, createPublicKey(pubPem), { issuer: "Iv1.clientid", currentDate: new Date(now * 1000) });
  ok(protectedHeader.alg === "RS256", "JWT is signed RS256");
  ok(payload.iss === "Iv1.clientid", "JWT issuer is the client id");
  ok(payload.iat === now - 60, "iat is back-dated 60s for clock drift");
  ok(payload.exp === now + 540, "exp is 9 minutes out (≤ 10 max)");
}

{
  const body = buildMintBody(["web", "web", "api"]);
  ok(body.repositories.length === 2 && body.repositories.includes("web") && body.repositories.includes("api"), "mint body dedups repo names");
  ok(body.permissions.contents === "write" && body.permissions.pull_requests === "write" && body.permissions.metadata === "read", "default permissions are least-privilege");
  ok(buildMintBody(Array.from({ length: 600 }, (_, i) => `r${i}`)).repositories.length === 500, "repo list is capped at 500");
  ok(DEFAULT_PERMISSIONS.contents === "write", "exported default permissions are correct");
}

{
  let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
  const fetchFn: FetchFn = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ token: "ghs_secret", expires_at: "2026-06-25T13:00:00Z", repository_selection: "selected", repositories: [{ full_name: "acme/web" }, { full_name: "acme/api" }] }),
    };
  };
  const tok = await mintInstallationToken({ jwt: "JWT", installationId: "4242", repoNames: ["web", "api"], fetchFn });
  ok(seen!.url.endsWith("/app/installations/4242/access_tokens"), "mint hits the installation access_tokens endpoint");
  ok(seen!.init.headers.authorization === "Bearer JWT", "mint sends the app JWT as Bearer");
  ok(JSON.parse(seen!.init.body).repositories.length === 2, "mint body carries the scoped repo subset");
  ok(tok.token === "ghs_secret" && tok.expiresAt === "2026-06-25T13:00:00Z", "token + expiry parsed from response");
  ok(tok.repositories.includes("acme/web"), "covered repositories parsed");

  const boom: FetchFn = async () => ({ ok: false, status: 403, text: async () => "forbidden", json: async () => ({}) });
  await assert.rejects(mintInstallationToken({ jwt: "x", installationId: "1", repoNames: [], fetchFn: boom }), /403 forbidden/);
  n++;
}

{
  const hdr = authExtraHeader("ghs_secret");
  ok(hdr === `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`, "extraheader is base64(x-access-token:TOKEN)");
  const clone = cloneArgs("acme/web", "ghs_secret", "/w/repo");
  ok(clone.includes("clone") && clone.includes("https://github.com/acme/web.git"), "clone targets the clean https url");
  ok(!clone.some((a) => a.includes("ghs_secret") && a.includes("https://")), "token is NOT embedded in the clone URL");
  ok(clone[0] === "-c" && clone[1].startsWith("http.extraheader="), "clone passes the token via -c http.extraheader (in-memory)");
  ok(pushArgs("ghs_secret", "fix/bug")[1].startsWith("http.extraheader="), "push re-injects the header");
  ok(fetchArgs("ghs_secret").includes("fetch"), "fetch re-injects the header");
}

{
  const c = botCommitter("open-everywhere", "12345");
  ok(c.name === "open-everywhere[bot]", "bot name is <slug>[bot]");
  ok(c.email === "12345+open-everywhere[bot]@users.noreply.github.com", "bot email is <id>+<slug>[bot]@users.noreply.github.com");
  const args = identityArgs("open-everywhere", "12345");
  ok(args.includes("user.name=open-everywhere[bot]") && args.includes("user.email=12345+open-everywhere[bot]@users.noreply.github.com"), "identity args stamp commit author without writing config");
}

{
  ok(loadGitHubAppConfig({}) === null, "plane is optional: null when unconfigured");
  const cfg = loadGitHubAppConfig({
    OE_GITHUB_APP_ID: "111",
    OE_GITHUB_APP_PRIVATE_KEY: pkcs1,
    OE_GITHUB_APP_SLUG: "open-everywhere",
    OE_GITHUB_BOT_USER_ID: "12345",
    OE_GITHUB_INSTALLATIONS: '{"acme":"4242"}',
    OE_GITHUB_OWNER: "globex",
    OE_GITHUB_INSTALLATION_ID: "9999",
  } as NodeJS.ProcessEnv)!;
  ok(cfg.appSlug === "open-everywhere" && cfg.botUserId === "12345", "config reads app fields");
  ok(cfg.installations.acme === "4242" && cfg.installations.globex === "9999", "config merges the JSON map and the single-owner pair");
}

{
  const calls: { installationId: string; body: { repositories: string[] } }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const installationId = url.match(/installations\/([^/]+)\//)![1];
    calls.push({ installationId, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => "", json: async () => ({ token: `tok_${installationId}`, expires_at: "2026-06-25T13:00:00Z", repositories: [] }) };
  };
  const app = new GitHubApp(
    { appId: "111", privateKeyPem: pkcs1, appSlug: "open-everywhere", botUserId: "12345", installations: { acme: "4242" } },
    { fetchFn, now: () => 1_750_000_000_000 },
  );
  const { tokens, ungranted } = await app.tokensForRepos(["acme/web", "acme/api", "globex/secret"]);
  ok(tokens.size === 1 && tokens.get("acme")!.token === "tok_4242", "one scoped token per granted owner");
  ok(calls.length === 1 && calls[0].body.repositories.length === 2, "the owner's two repos are scoped into a single token (mint per owner, not per repo)");
  ok(ungranted.length === 1 && ungranted[0] === "globex/secret", "a repo whose owner has no installation is reported ungranted, never widened");
  ok(app.committer().email === "12345+open-everywhere[bot]@users.noreply.github.com", "orchestrator exposes the bot committer");
}

{
  const escaped = pkcs1.replace(/\n/g, "\\n");
  ok(escaped.includes("\\n") && !escaped.includes("\n"), "fixture builds an escaped-newline PEM");
  ok(normalizePrivateKeyPem(escaped).includes("\n"), "normalizePrivateKeyPem restores newlines");
  ok(!!parsePrivateKey(escaped), "parsePrivateKey accepts an escaped-newline PEM (via normalize)");
  ok(normalizePrivateKeyPem(pkcs1) === pkcs1, "normalize is a no-op on a real-newline PEM");
}

{
  ok(repoAllowed("acme/web", ["acme/web", "acme/api"]), "repoAllowed accepts a granted repo");
  ok(!repoAllowed("acme/secret", ["acme/web"]), "repoAllowed rejects an ungranted repo");
}

{
  const cmd = checkoutCommand("acme/web", "ghs_secret", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes("clone -- 'https://github.com/acme/web.git' 'repo'"), "checkout clones the clean https url");
  ok(!cmd.includes("ghs_secret@"), "token is NOT in the clone URL");
  ok(cmd.includes("http.extraheader=AUTHORIZATION: basic"), "token rides in http.extraheader");
  ok(cmd.includes("git -C 'repo' config http.extraheader"), "header is persisted to the clone so later push/fetch are authed");
  ok(cmd.includes("config user.name 'open-everywhere[bot]'"), "bot identity is configured");
  ok(cmd.includes(CHECKOUT_OK), "command prints the success sentinel");
  ok(isSafeCheckoutDir("svc/web") && !isSafeCheckoutDir("../etc"), "checkout dir guard blocks traversal");
  ok(!isSafeCheckoutDir("a'; rm -rf /"), "checkout dir guard blocks shell metacharacters");
}

{
  const tok = "ghs_secret";
  const b64 = Buffer.from(`x-access-token:${tok}`, "utf-8").toString("base64");
  const out = redactSecret(`fatal: ${tok} bad; header ${b64}`, tok);
  ok(!out.includes(tok) && !out.includes(b64) && out.includes("[REDACTED]"), "redactSecret scrubs token + base64 form");
}

{
  const probe = conventionProbe("repo");
  ok(probe.includes("AGENTS.md") && probe.includes("CLAUDE.md"), "probe checks both AGENTS.md and CLAUDE.md");
  ok(probe.indexOf("AGENTS.md") < probe.indexOf("CLAUDE.md"), "probe prefers AGENTS.md (listed first; shell breaks on first match)");
  ok(probe.includes("'repo'/"), "probe scopes to the checkout dir");
  ok(CONVENTION_FILES[0] === "AGENTS.md" && CONVENTION_FILES[1] === "CLAUDE.md", "AGENTS.md is the priority convention file");

  const cmd = checkoutCommand("acme/web", "ghs_x", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes(CONV_MARKER), "checkoutCommand includes the convention probe");
  ok(cmd.indexOf(CONV_MARKER) < cmd.indexOf(CHECKOUT_OK), "probe runs before the OK sentinel");

  const found = parseConventionProbe(`some clone noise\n${CONV_MARKER} AGENTS.md 42 1337\n${CHECKOUT_OK}`);
  ok(found?.file === "AGENTS.md" && found.lines === 42 && found.bytes === 1337, "parseConventionProbe reads file/lines/bytes");
  ok(parseConventionProbe(`${CONV_MARKER} CLAUDE.md 5 90`)?.file === "CLAUDE.md", "parseConventionProbe handles the CLAUDE.md fallback");
  ok(parseConventionProbe(`${CHECKOUT_OK}`) === null, "parseConventionProbe returns null when no convention file");
  ok(parseConventionProbe(`${CONV_MARKER} AGENTS.md notanumber 5`) === null, "parseConventionProbe ignores a malformed line");
}

{
  const probe = skillsProbe("repo");
  ok(probe.includes(".agents/skills") && probe.includes(".claude/skills"), "skills probe checks both roots");
  ok(probe.indexOf(".agents/skills") < probe.indexOf(".claude/skills"), "skills probe prefers .agents/skills (first existing root wins; never merged)");
  ok(SKILL_ROOTS[0] === ".agents/skills" && SKILL_ROOTS[1] === ".claude/skills", ".agents/skills is the priority root");
  ok(probe.includes("'repo'/"), "skills probe scopes to the checkout dir");
  ok(probe.includes(`head -c ${MAX_SKILL_BYTES}`), "each SKILL.md is byte-bounded BEFORE encoding");
  ok(probe.indexOf("head -c") < probe.indexOf("base64"), "the byte bound is applied before base64");
  ok(probe.includes("base64 -w0"), "content rides as single-line base64 (can't collide with markers)");
  ok(probe.includes(`-ge ${MAX_REPO_SKILLS}`) && probe.includes(SKILL_TRUNC_MARKER), "the loop is capped with a truncation marker");

  const cmd = checkoutCommand("acme/web", "ghs_x", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes(SKILL_MARKER), "checkoutCommand includes the skills probe");
  ok(cmd.indexOf(SKILL_MARKER) < cmd.indexOf(CHECKOUT_OK), "skills probe runs before the OK sentinel");
}

{
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const out = parseSkillsProbe(
    [
      "clone noise",
      `${SKILL_MARKER} deploy ${b64("---\ndescription: Ship it.\n---\nSteps.")}`,
      `${SKILL_MARKER} db-migrate ${b64("# Migrations")}`,
      CHECKOUT_OK,
    ].join("\n"),
  );
  ok(Object.keys(out.skills).length === 2 && out.skills["deploy"].includes("Ship it."), "parseSkillsProbe decodes name + content per marker line");
  ok(out.truncated === false, "no truncation marker → truncated false");

  ok(Object.keys(parseSkillsProbe(`${SKILL_MARKER} evil not!base64!`).skills).length === 0, "bad base64 is skipped, not thrown on");
  ok(Object.keys(parseSkillsProbe(`${SKILL_MARKER} ../escape ${b64("x")}`).skills).length === 0, "an unsafe skill name is skipped");
  ok(Object.keys(parseSkillsProbe(`${SKILL_MARKER} empty ${b64("  ")}`).skills).length === 0, "empty content is skipped");
  ok(parseSkillsProbe(`${SKILL_MARKER} a ${b64("x")}\n${SKILL_TRUNC_MARKER}`).truncated === true, "truncation marker is reported");
  const none = parseSkillsProbe(CHECKOUT_OK);
  ok(Object.keys(none.skills).length === 0 && !none.truncated, "no marker lines → zero skills");
}

{
  ok(repoSlug("acme/payments-api", {}) === "payments-api", "repoSlug is the slugged short name");
  const taken: Record<string, RepoSkillsEntry> = { "payments-api": { repo: "globex/payments-api", skills: {} } };
  ok(repoSlug("acme/payments-api", taken) === `acme${REPO_SKILL_SEP}payments-api`, "a short-name collision falls back to owner--repo");
  const same: Record<string, RepoSkillsEntry> = { "payments-api": { repo: "acme/payments-api", skills: {} } };
  ok(repoSlug("acme/payments-api", same) === "payments-api", "re-checkout of the SAME repo keeps its slug");
  ok(isSafeSkillName("payments-api--deploy") && !isSafeSkillName("a:b") && !isSafeSkillName("../x"), "safe-name mirror rejects ':' and traversal (Eve's rule)");
}

{
  const warns: string[] = [];
  const state: Record<string, RepoSkillsEntry> = {
    "payments-api": {
      repo: "acme/payments-api",
      skills: { deploy: "---\ndescription: Ship it.\n---\nSteps.", "db-migrate": "# No frontmatter", "bad name": "x" },
    },
  };
  const merged = mergeRepoSkills(state, new Set(["deploy", "linear"]), (m) => warns.push(m));
  ok(Object.keys(merged).every((k) => k.includes(REPO_SKILL_SEP)), "every repo skill is namespaced — never a bare name");
  ok("payments-api--deploy" in merged && "payments-api--db-migrate" in merged, "names are <repoSlug>--<skill>");
  ok(!("deploy" in merged), "a granted bare name ('deploy') is untouched by repo skills");
  ok(merged["payments-api--deploy"].description === "Ship it.", "description comes from SKILL.md frontmatter");
  ok(merged["payments-api--db-migrate"].description.includes("acme/payments-api"), "missing frontmatter gets a provenance fallback description");
  ok(!Object.keys(merged).some((k) => k.includes("bad name")) && warns.some((w) => w.includes("unsafe name")), "an unsafe composed name is dropped with a warn");

  const collided = mergeRepoSkills(state, new Set(["payments-api--deploy"]), (m) => warns.push(m));
  ok(!("payments-api--deploy" in collided) && warns.some((w) => w.includes("granted wins")), "granted skill wins a namespaced collision; repo skill dropped with a warn");
  ok(Object.keys(mergeRepoSkills({}, new Set())).length === 0, "empty state → no repo skills (fail-soft resolver path)");
}

{
  const probe = agentsProbe("repo");
  ok(probe.includes(".agents/agents") && probe.includes(".claude/agents"), "agents probe checks both roots");
  ok(probe.indexOf(".agents/agents") < probe.indexOf(".claude/agents"), "agents probe prefers .agents/agents (first existing root wins; never merged)");
  ok(AGENT_ROOTS[0] === ".agents/agents" && AGENT_ROOTS[1] === ".claude/agents", ".agents/agents is the priority root");
  ok(probe.includes("'repo'/"), "agents probe scopes to the checkout dir");
  ok(probe.includes('"$ar"/*.md') && probe.includes('basename "$f" .md'), "agents are flat <name>.md files; the name is the basename without .md");
  ok(probe.includes(`head -c ${MAX_SKILL_BYTES}`) && probe.indexOf("head -c") < probe.indexOf("base64"), "each agent file is byte-bounded BEFORE encoding");
  ok(probe.includes(`-ge ${MAX_REPO_AGENTS}`) && probe.includes(AGENT_TRUNC_MARKER), "the loop is capped with a truncation marker");
  ok(probe.includes("ar=''") && probe.includes("m=0") && skillsProbe("repo").includes("sr=''"), "agents probe uses its own shell vars (runs in the same script as the skills probe)");

  const cmd = checkoutCommand("acme/web", "ghs_x", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes(AGENT_MARKER), "checkoutCommand includes the agents probe");
  ok(cmd.indexOf(AGENT_MARKER) < cmd.indexOf(CHECKOUT_OK), "agents probe runs before the OK sentinel");
}

{
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const md = "---\nname: code-reviewer\ndescription: Reviews diffs for bugs.\nmodel: haiku\ntools: [Read, Grep]\n---\nYou are a meticulous reviewer.";
  const out = parseAgentsProbe(`noise\n${AGENT_MARKER} reviewer ${b64(md)}\n${CHECKOUT_OK}`);
  ok(Object.keys(out.agents).length === 1 && out.agents["reviewer"] === md && !out.truncated, "parseAgentsProbe decodes basename + content per marker line");
  ok(Object.keys(parseAgentsProbe(`${AGENT_MARKER} evil not!base64!`).agents).length === 0, "agent bad base64 is skipped");
  ok(Object.keys(parseAgentsProbe(`${AGENT_MARKER} ../up ${b64("x")}`).agents).length === 0, "an unsafe agent basename is skipped");
  ok(parseAgentsProbe(`${AGENT_MARKER} a ${b64("x")}\n${AGENT_TRUNC_MARKER}`).truncated === true, "agent truncation marker is reported");

  const def = parseRepoAgent("reviewer", md);
  ok(def.name === "code-reviewer" && def.description === "Reviews diffs for bugs.", "parseRepoAgent reads frontmatter name + description");
  ok(def.model === "haiku" && def.tools?.length === 2 && def.tools[0] === "Read", "model + tools are parsed and KEPT (dropped-with-reason at merge, usable by a future real-subagent mapping)");
  ok(def.body === "You are a meticulous reviewer.", "the body is the persona, frontmatter stripped");

  const bare = parseRepoAgent("triage", "Just a persona, no frontmatter.");
  ok(bare.name === "triage" && bare.body === "Just a persona, no frontmatter." && bare.description === "", "a frontmatter-less file falls back to the basename, body verbatim");
  ok(parseRepoAgent("fallback", "---\nname: Code Reviewer\n---\nBody.").name === "code-reviewer", "an unsafe frontmatter name is slugged (Eve's safe-name rule)");
  ok(parseRepoAgent("t", "---\ntools: Read, Bash\n---\nB.").tools?.join("|") === "Read|Bash", "a comma-string tools list is split");
}

{
  const warns: string[] = [];
  const state: Record<string, RepoSkillsEntry> = {
    "payments-api": {
      repo: "acme/payments-api",
      skills: { deploy: "---\ndescription: Ship it.\n---\nSteps." },
      agents: {
        "code-reviewer": { name: "code-reviewer", description: "Reviews diffs for bugs.", body: "You are a meticulous reviewer.", model: "haiku", tools: ["Read"] },
        deploy: { name: "deploy", description: "Clashes with the skill.", body: "x" },
        "no-desc": { name: "no-desc", description: "", body: "Persona." },
      },
    },
  };
  const merged = mergeRepoSkills(state, new Set(["payments-api--code-reviewer-granted"]), (m) => warns.push(m));
  const reviewer = merged["payments-api--code-reviewer"];
  ok(!!reviewer && reviewer.description === "Reviews diffs for bugs.", "an agent surfaces as <repoSlug>--<name> with ITS description (the when-to-delegate signal)");
  ok(reviewer.markdown.startsWith(delegationHeader("acme/payments-api")), "the skill content starts with the trusted delegation header (repo interpolated)");
  ok(reviewer.markdown.includes("call the `agent` tool") && reviewer.markdown.endsWith("You are a meticulous reviewer.\n"), "header explains the agent-tool mapping; persona body rides verbatim after it");
  ok(!reviewer.markdown.includes("haiku"), "frontmatter model is dropped from the skill content (ignored at runtime; per-domain routing applies)");
  ok(merged["payments-api--deploy"].description === "Ship it." && warns.some((w) => w.includes("the skill wins")), "on a same-repo skill/agent name clash the SKILL wins, agent dropped with a warn");
  ok(merged["payments-api--no-desc"].description.includes("Delegation persona"), "a description-less agent gets a provenance fallback description");

  const granted = mergeRepoSkills(state, new Set(["payments-api--code-reviewer"]), (m) => warns.push(m));
  ok(!("payments-api--code-reviewer" in granted), "a granted skill wins a namespaced collision with an agent too");
  const legacy = mergeRepoSkills({ web: { repo: "acme/web", skills: { s: "# S" } } }, new Set());
  ok("web--s" in legacy, "state persisted before the agents field still merges (agents optional)");
}

{
  const base = (repos: string[]): EffectiveAccess => ({
    mode: "channel", scopeKey: "x", connections: [], connectorCredentials: {}, reachableHosts: [], repos, plugins: [], skills: [], subagents: [], connectors: [], instructionStack: [], warnings: [],
  });
  const withRepos = await compileNetworkPolicy(base(["acme/web"]), async () => ({}));
  const allow = (typeof withRepos === "object" ? withRepos.allow : undefined) as Record<string, unknown[]> | undefined;
  ok(!!allow && "github.com" in allow, "granted repos add a github.com egress allow");
  ok(!!allow && allow["github.com"].length === 0, "github.com is a BARE allow (option-1: no firewall header)");
  ok((await compileNetworkPolicy(base([]), async () => ({}))) === "deny-all", "no hosts + no repos → deny-all (fail closed)");
}

console.log(`\n✓ scm: ${n} assertions passed (JWT, scoping, git-arg safety, identity, config, orchestrator, checkout cmd, convention probe, repo skills, repo agents, guards, egress)\n`);
