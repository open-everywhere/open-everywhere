
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-control-memory-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_MEMORY_PROVIDER;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { defineMemorySilo } = await import("../agent/memory/silo.js");
const { providerById, registerProvider } = await import("../agent/memory/provider.js");
const { siloTier } = await import("../agent/memory/store.js");
const { controlPartition } = await import("../agent/memory/partition.js");
const { readAudit } = await import("../agent/audit/audit.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const callJson = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, body: JSON.parse((res.content as { type: string; text: string }[])[0].text) };
};

const engSilo = defineMemorySilo({ name: "eng-silo", provider: "sqlite" });
const orgSilo = defineMemorySilo({ name: "org-brain", provider: "sqlite" });
const domains = [
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], memory: "eng-silo" }),
  defineDomain({ name: "org", match: "org", memory: "org-brain" }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [engSilo, orgSilo],
  domainsForSurface: () => [],
});

const org = "acme";
await providerById("sqlite").ensureTier(controlPartition(org), siloTier("eng-silo"), engSilo);
await providerById("sqlite").writeTier(controlPartition(org), siloTier("eng-silo"), { "MEMORY.md": "# eng\n\n## Notes\n- a: hello\n", "people.md": "# People\n- a: hi\n" }, "seed", engSilo);
await providerById("sqlite").ensureTier(controlPartition(org), siloTier("org-brain"), orgSilo);

{
  const readonly = Object.keys((buildControlServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("read-only server exposes exactly CONTROL_TOOL_NAMES (incl. memory_list/memory_read)", JSON.stringify(readonly) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
  ok("memory_list/memory_read are on the read-only surface", readonly.includes("memory_list") && readonly.includes("memory_read"));
  const withWrites = Object.keys((buildControlServer({ includeWrites: true, actor: "t" }) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("write server exposes memory_write_file + memory_delete_file", CONTROL_WRITE_TOOL_NAMES.every((t) => withWrites.includes(t)));
}

{
  const server = buildControlServer({ roles: ["admin"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "admin", version: "0" });
  await client.connect(c);

  const list = await callJson(client, "memory_list", { org });
  ok("memory_list (admin): sees both silos", list.body.tiers.length === 2 && list.body.tiers.some((t: { silo: string }) => t.silo === "eng-silo") && list.body.tiers.some((t: { silo: string }) => t.silo === "org-brain"));
  const engRow = list.body.tiers.find((t: { silo: string }) => t.silo === "eng-silo");
  ok("memory_list: file listing has sizes + a total", engRow.files.some((f: { path: string; bytes: number }) => f.path === "MEMORY.md" && f.bytes > 0) && engRow.totalBytes > 0);
  ok("memory_list: covering domain is reported (eng-silo <- \"eng\")", JSON.stringify(engRow.domains) === JSON.stringify(["eng"]));
  const orgRow = list.body.tiers.find((t: { silo: string }) => t.silo === "org-brain");
  ok("memory_list: org-brain reports NO covering explicit domain (pseudo-domain only)", orgRow.domains.length === 0);

  const read = await callJson(client, "memory_read", { org, silo: "eng-silo", relPath: "MEMORY.md" });
  ok("memory_read (admin): returns the file content", read.body.content.includes("hello"));
  const readOrg = await callJson(client, "memory_read", { org, silo: "org-brain", relPath: "MEMORY.md" });
  ok("memory_read (admin): org-brain is readable by admin", typeof readOrg.body.content === "string");

  const missingFile = await client.callTool({ name: "memory_read", arguments: { org, silo: "eng-silo", relPath: "nope.md" } });
  ok("memory_read: an absent relPath errors (not a guessed/empty read)", missingFile.isError === true);
  const missingSilo = await client.callTool({ name: "memory_read", arguments: { org, silo: "no-such-silo", relPath: "MEMORY.md" } });
  ok("memory_read: an unknown silo errors", missingSilo.isError === true);
  const traversal = await client.callTool({ name: "memory_read", arguments: { org, silo: "eng-silo", relPath: "../../etc/passwd" } });
  ok("memory_read: a path-traversal relPath is refused", traversal.isError === true);

  await client.close();
}

{
  const server = buildControlServer({ roles: ["domain:eng"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "domain-eng", version: "0" });
  await client.connect(c);

  const list = await callJson(client, "memory_list", { org });
  ok("memory_list (domain:eng): sees ONLY eng-silo, not org-brain", list.body.tiers.length === 1 && list.body.tiers[0].silo === "eng-silo");

  const readOk = await callJson(client, "memory_read", { org, silo: "eng-silo", relPath: "MEMORY.md" });
  ok("memory_read (domain:eng): its own silo is readable", readOk.body.content.includes("hello"));

  const readDenied = await client.callTool({ name: "memory_read", arguments: { org, silo: "org-brain", relPath: "MEMORY.md" } });
  ok("memory_read (domain:eng): org-brain is DENIED — pseudo-domain reference doesn't count as covering", readDenied.isError === true);

  await client.close();
}

{
  const server = buildControlServer({ roles: ["domain:org"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "domain-org", version: "0" });
  await client.connect(c);
  const list = await callJson(client, "memory_list", { org });
  ok('memory_list ("domain:org"): org-brain is still excluded (a pseudo-domain never covers)', list.body.tiers.length === 0);
  const denied = await client.callTool({ name: "memory_read", arguments: { org, silo: "org-brain", relPath: "MEMORY.md" } });
  ok('memory_read ("domain:org"): still denied', denied.isError === true);
  await client.close();
}

{
  const server = buildControlServer({ roles: [] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "no-roles", version: "0" });
  await client.connect(c);
  const list = await callJson(client, "memory_list", { org });
  ok("memory_list (no roles): empty", list.body.tiers.length === 0);
  const denied = await client.callTool({ name: "memory_read", arguments: { org, silo: "eng-silo", relPath: "MEMORY.md" } });
  ok("memory_read (no roles): denied", denied.isError === true);
  await client.close();
}

{
  const domainServer = buildControlServer({ includeWrites: true, actor: "eng-op", roles: ["domain:eng"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await domainServer.connect(s);
  const domainClient = new Client({ name: "domain-eng-write", version: "0" });
  await domainClient.connect(c);
  const denied = await domainClient.callTool({ name: "memory_write_file", arguments: { org, silo: "eng-silo", relPath: "notes.md", content: "# Notes\n- x\n" } });
  ok("memory_write_file: a domain:eng role is denied (v1 is admin-only for writes)", denied.isError === true);
  const deniedDelete = await domainClient.callTool({ name: "memory_delete_file", arguments: { org, silo: "eng-silo", relPath: "people.md" } });
  ok("memory_delete_file: a domain:eng role is denied (v1 is admin-only for writes)", deniedDelete.isError === true);
  await domainClient.close();
}

{
  const server = buildControlServer({ includeWrites: true, actor: "admin@example.com", roles: ["admin"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "admin-write", version: "0" });
  await client.connect(c);

  const write = await callJson(client, "memory_write_file", { org, silo: "eng-silo", relPath: "notes.md", content: "# Notes\n- new note\n" });
  ok("memory_write_file: creates a new file", write.body.ok === true);
  const read = await callJson(client, "memory_read", { org, silo: "eng-silo", relPath: "notes.md" });
  ok("memory_write_file: the new content round-trips", read.body.content === "# Notes\n- new note\n");

  const overwritten = await callJson(client, "memory_write_file", { org, silo: "eng-silo", relPath: "notes.md", content: "# Notes\n- replaced\n" });
  ok("memory_write_file: a second call fully replaces (not appends)", overwritten.body.ok === true);
  const read2 = await callJson(client, "memory_read", { org, silo: "eng-silo", relPath: "notes.md" });
  ok("memory_write_file: replace really replaced (no leftover 'new note')", read2.body.content === "# Notes\n- replaced\n" && !read2.body.content.includes("new note"));

  const badExt = await client.callTool({ name: "memory_write_file", arguments: { org, silo: "eng-silo", relPath: "notes.json", content: "{}" } });
  ok("memory_write_file: refuses a non-.md/.txt extension", badExt.isError === true);

  const marker = await client.callTool({ name: "memory_write_file", arguments: { org, silo: "eng-silo", relPath: "_onboarded", content: "2026-07-04" } });
  ok("memory_write_file: refuses a \"_\"-prefixed operational marker", marker.isError === true);

  const traversal = await client.callTool({ name: "memory_write_file", arguments: { org, silo: "eng-silo", relPath: "../escape.md", content: "x" } });
  ok("memory_write_file: refuses relPath traversal", traversal.isError === true);

  const tooBig = await client.callTool({ name: "memory_write_file", arguments: { org, silo: "eng-silo", relPath: "big.md", content: "x".repeat(64 * 1024 + 1) } });
  ok("memory_write_file: refuses over the 64KB cap", tooBig.isError === true);

  const del = await callJson(client, "memory_delete_file", { org, silo: "eng-silo", relPath: "people.md" });
  ok("memory_delete_file: reports deleted=true", del.body.deleted === true);
  const listAfterDelete = await callJson(client, "memory_list", { org });
  const engAfter = listAfterDelete.body.tiers.find((t: { silo: string }) => t.silo === "eng-silo");
  ok("memory_delete_file: the file is ACTUALLY gone (real DELETE, not a no-op)", !engAfter.files.some((f: { path: string }) => f.path === "people.md"));
  ok("memory_delete_file: sibling files are untouched", engAfter.files.some((f: { path: string }) => f.path === "MEMORY.md"));

  const missing = await callJson(client, "memory_delete_file", { org, silo: "eng-silo", relPath: "people.md" });
  ok("memory_delete_file: deleting an already-absent file reports deleted=false (idempotent)", missing.body.deleted === false);

  const markerDelete = await client.callTool({ name: "memory_delete_file", arguments: { org, silo: "eng-silo", relPath: "_onboarded" } });
  ok("memory_delete_file: also refuses a \"_\"-prefixed marker", markerDelete.isError === true);

  await client.close();
}

{
  registerProvider({
    id: "no-delete-backend",
    async readTier() {
      return { "MEMORY.md": "# x\n" };
    },
    async ensureTier() {
      return { "MEMORY.md": "# x\n" };
    },
    async writeTier() {
      return "v1";
    },
    async deleteTier() {
    },
  });
  const noDeleteSilo = { name: "no-delete-silo", provider: "no-delete-backend" };
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [...domains, defineDomain({ name: "nodelete", channels: ["slack/T1/C_ND"], memory: "no-delete-silo" })],
    loadSilos: () => [engSilo, orgSilo, noDeleteSilo],
    domainsForSurface: () => [],
  });

  const server = buildControlServer({ includeWrites: true, actor: "admin@example.com", roles: ["admin"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "no-delete", version: "0" });
  await client.connect(c);
  const res = await client.callTool({ name: "memory_delete_file", arguments: { org, silo: "no-delete-silo", relPath: "MEMORY.md" } });
  ok("memory_delete_file: a backend without deleteFile FAILS LOUD (never a silent, falsely-successful no-op)", res.isError === true);
  const text = (res.content as { type: string; text: string }[])[0].text;
  ok("memory_delete_file: the error names the unsupported backend", text.includes("no-delete-backend"));
  await client.close();
}

{
  const audit = await readAudit({ org });
  const actions = audit.filter((e) => e.action === "memory.write" || e.action === "memory.delete");
  ok("memory writes/deletes are audited", actions.length >= 2);
  ok("audited actions carry the acting principal", actions.every((e) => e.principalId === "admin@example.com"));
  ok("audited detail carries the silo + relPath", actions.every((e) => typeof e.detail?.silo === "string" && typeof e.detail?.relPath === "string"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ memory-admin control-plane MCP: ${n} assertions passed\n`);
