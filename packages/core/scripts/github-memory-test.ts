import { GitHubContents, type HttpFetch } from "../agent/scm/contents.js";
import { makeGitHubProvider } from "../agent/memory/github.js";
import { siloTier } from "../agent/memory/store.js";
import type { Partition } from "../agent/memory/partition.js";
import type { MemorySilo } from "../agent/memory/silo.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const store = new Map<string, Map<string, { content: string; sha: string }>>();
let shaSeq = 0;
function repoFiles(repo: string): Map<string, { content: string; sha: string }> {
  let m = store.get(repo);
  if (!m) {
    m = new Map();
    store.set(repo, m);
  }
  return m;
}
function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

const fakeFetch: HttpFetch = async (url, init) => {
  const u = new URL(url);
  const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.*)$/);
  if (!m) return res(404, { message: "not found" });
  const repo = m[1];
  const path = decodeURIComponent(m[2].split("/").map(decodeURIComponent).join("/"));
  const files = repoFiles(repo);

  if (init.method === "GET") {
    if (files.has(path)) {
      const f = files.get(path)!;
      return res(200, { type: "file", path, name: path.split("/").pop(), sha: f.sha, encoding: "base64", content: Buffer.from(f.content, "utf-8").toString("base64") });
    }
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; path: string; name: string; sha: string }>();
    for (const [fp, f] of files) {
      if (!fp.startsWith(prefix)) continue;
      const rest = fp.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) children.set(fp, { type: "file", path: fp, name: rest, sha: f.sha });
      else {
        const dirName = rest.slice(0, slash);
        const dirPath = `${path}/${dirName}`;
        if (!children.has(dirPath)) children.set(dirPath, { type: "dir", path: dirPath, name: dirName, sha: `dir-${dirName}` });
      }
    }
    if (children.size === 0) return res(404, { message: "not found" });
    return res(200, [...children.values()]);
  }

  if (init.method === "PUT") {
    const body = JSON.parse(init.body ?? "{}") as { content: string; sha?: string };
    const sha = `sha${++shaSeq}`;
    files.set(path, { content: Buffer.from(body.content, "base64").toString("utf-8"), sha });
    return res(200, { commit: { sha: `commit${shaSeq}` }, content: { sha } });
  }

  if (init.method === "DELETE") {
    files.delete(path);
    return res(200, { commit: { sha: `del${++shaSeq}` } });
  }
  return res(405, { message: "method not allowed" });
};

const provider = makeGitHubProvider({
  contents: new GitHubContents(fakeFetch, "https://api.github.com"),
  mintToken: async () => "fake-token",
  committer: () => ({ name: "open-everywhere[bot]", email: "bot@users.noreply.github.com" }),
  branch: "main",
});

function partition(org: string): Partition {
  return { org, platform: "slack", workspace: "T", surface: "C", workspaceKey: "slack/T", surfaceKey: "slack/T/C", key: "slack/T/C" };
}
const silo: MemorySilo = { name: "txn", provider: "github", container: "acme/brain", path: "memory" };
const tier = siloTier("txn");
const p = partition("default");

ok(Object.keys(await provider.readTier(p, tier, silo)).length === 0, "fresh tier reads empty");

const seeded = await provider.ensureTier(p, tier, silo);
ok("MEMORY.md" in seeded && seeded["MEMORY.md"].includes('"txn"'), "ensureTier seeds the silo MEMORY.md");

ok(repoFiles("acme/brain").has("memory/default/@silos/txn/MEMORY.md"), "file keyed by silo.path + org + tier path");

const reseed = await provider.ensureTier(p, tier, silo);
ok(reseed["MEMORY.md"] === seeded["MEMORY.md"], "ensureTier idempotent");

ok((await provider.writeTier(p, tier, seeded, "noop", silo)) === null, "unchanged write returns null");

const v = await provider.writeTier(p, tier, { "MEMORY.md": "# changed\n" }, "edit", silo);
ok(typeof v === "string" && v!.length > 0, "changed write returns a token");
ok((await provider.readTier(p, tier, silo))["MEMORY.md"] === "# changed\n", "write is durable");

await provider.writeTier(p, tier, { "people.md": "@ana owns deploys\n" }, "add", silo);
const both = await provider.readTier(p, tier, silo);
ok(both["MEMORY.md"] === "# changed\n" && both["people.md"] === "@ana owns deploys\n", "writes union (never drop)");

await provider.writeTier(p, tier, { "MEMORY.md": "# changed\n", "sub/notes.md": "nested\n" }, "nest", silo);
const flat = await provider.readTier(p, tier, { ...silo, recursive: false });
ok("MEMORY.md" in flat && !("sub/notes.md" in flat), "recursive:false → top-level files only (sub-folders skipped)");
const deep = await provider.readTier(p, tier, silo);
ok("sub/notes.md" in deep, "default recursive → nested file included");

await provider.writeTier(
  p,
  tier,
  { "MEMORY.md": "# changed\n", "keep/notes.md": "wanted\n", "drop/junk.md": "noise\n" },
  "subset-fixture",
  silo,
);
const subset = await provider.readTier(p, tier, {
  ...silo,
  select: { default: "include", rules: [{ path: "keep", mode: "recurse" }] },
});
ok("MEMORY.md" in subset, "select: top-level file kept");
ok("keep/notes.md" in subset, "select: ticked sub-folder included");
ok(!("drop/junk.md" in subset), "select: unticked sub-folder excluded");

await provider.deleteTier(p, tier, silo);
await provider.writeTier(p, tier, { "MEMORY.md": "# changed\n", "people.md": "@ana owns deploys\n" }, "restore", silo);

ok((await provider.tierVersion!(partition("org-never-written"), tier, silo)) === null, "tierVersion is null for an empty/absent tier");
const dBefore = await provider.tierVersion!(p, tier, silo);
ok(typeof dBefore === "string" && dBefore.length > 0, "tierVersion is non-null once written");
ok((await provider.tierVersion!(p, tier, silo)) === dBefore, "tierVersion is stable while nothing changes (the skip gate)");
await provider.writeTier(p, tier, { "people.md": "@ana owns deploys; @bo owns memory\n" }, "bump", silo);
const dAfter = await provider.tierVersion!(p, tier, silo);
ok(typeof dAfter === "string" && dAfter !== dBefore, "tierVersion advances on a changed write (new blob sha changes the listing digest)");

const other = partition("org-b");
ok(Object.keys(await provider.readTier(other, tier, silo)).length === 0, "org-b can't see org-a's tier");

const delToken = await provider.deleteFile!(p, tier, "people.md", silo);
ok(typeof delToken === "string" && delToken.length > 0, "deleteFile: returns a commit token");
ok(!repoFiles("acme/brain").has("memory/default/@silos/txn/people.md"), "deleteFile: the repo file is actually gone");
ok(!("people.md" in (await provider.readTier(p, tier, silo))), "deleteFile: the tier read no longer sees it");
ok((await provider.readTier(p, tier, silo))["MEMORY.md"] === "# changed\n", "deleteFile: sibling file (MEMORY.md) untouched");

const delAgain = await provider.deleteFile!(p, tier, "people.md", silo);
ok(delAgain === null, "deleteFile: deleting an already-absent file is idempotent (null, not an error)");

let forceDeleteFail = false;
const flakyFetch: HttpFetch = async (url, init) => {
  if (init.method === "DELETE" && forceDeleteFail) return res(403, { message: "insufficient_scope" });
  return fakeFetch(url, init);
};
const flakyProvider = makeGitHubProvider({
  contents: new GitHubContents(flakyFetch, "https://api.github.com"),
  mintToken: async () => "fake-token",
  committer: () => ({ name: "open-everywhere[bot]", email: "bot@users.noreply.github.com" }),
  branch: "main",
});
await flakyProvider.writeTier(p, tier, { "flaky.md": "x\n" }, "seed flaky", silo);
forceDeleteFail = true;
try {
  await flakyProvider.deleteFile!(p, tier, "flaky.md", silo);
  ok(false, "deleteFile: a transport failure should have thrown");
} catch (e) {
  ok(e instanceof Error && e.message.includes("insufficient_scope"), "deleteFile: a non-404 transport failure THROWS (never a silent no-op reporting success)");
}
forceDeleteFail = false;
await flakyProvider.deleteFile!(p, tier, "flaky.md", silo);

await provider.deleteTier(p, tier, silo);
ok(Object.keys(await provider.readTier(p, tier, silo)).length === 0, "deleteTier erases the tier");
ok(!repoFiles("acme/brain").has("memory/default/@silos/txn/MEMORY.md"), "delete removed the repo files");

try {
  await provider.readTier(p, tier, { name: "x", provider: "github" });
  ok(false, "missing container should throw");
} catch {
  ok(true, "missing container → throws");
}

console.log(`✓ github-memory: ${passed} assertions passed (Contents API client + github backing, offline fake)`);
