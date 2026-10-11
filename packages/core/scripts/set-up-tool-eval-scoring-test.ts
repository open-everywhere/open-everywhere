import assert from "node:assert/strict";
import { CANNED_PAGES, DOCS_URL, MCP_URL, scoreSetUpRun, type RecordedCall } from "./eval/set-up-tool-offline.js";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const research: RecordedCall[] = [
  { name: "web_search", input: { query: "FullStory MCP server" } },
  { name: "web_fetch", input: { url: DOCS_URL } },
  { name: "web_fetch", input: { url: "https://auth.fullstory.com/.well-known/oauth-authorization-server" } },
];
const proposal = (over: Record<string, unknown> = {}): RecordedCall => ({
  name: "propose_mcp_server",
  input: { name: "fullstory", url: MCP_URL, description: "FullStory: search sessions.", docUrls: [DOCS_URL], ...over },
});

ok(CANNED_PAGES[DOCS_URL]!.includes(MCP_URL), "the canned docs page names the MCP URL the scorer expects");
const good = scoreSetUpRun([...research, proposal()]);
ok(good.pass && good.diffEntry?.includes(`"url": "${MCP_URL}"`) === true, "a researched proposal of the documented entry passes, and yields the one-entry diff");
ok(!scoreSetUpRun([proposal()]).pass, "a proposal with no research fails");
ok(!scoreSetUpRun(research).pass, "research with no proposal fails");
ok(!scoreSetUpRun([...research, { name: "request_access", input: { kind: "grant-connector", connector: "fullstory" } }, proposal()]).pass, "reaching for request_access fails");
ok(!scoreSetUpRun([...research, proposal({ url: "https://api.fullstory.com/mcp" })]).pass, "a URL the docs do not give fails");
ok(
  !scoreSetUpRun([...research, proposal({ signIn: { mode: "static-confidential", authorizationEndpoint: "https://a.example/a", tokenEndpoint: "https://a.example/t", clientId: "x", clientSecretRef: "db:x:y", bodyEncoding: "form" } })]).pass,
  "a static client where the metadata advertises dynamic registration fails",
);
ok(!scoreSetUpRun([...research, proposal({ docUrls: ["https://github.com/someone/fullstory-mcp"] })]).pass, "citing only the unofficial community server fails");
ok(!scoreSetUpRun([...research, proposal({ docUrls: [DOCS_URL, "https://made-up.example/page"] })]).pass, "citing a page it never fetched or found fails");
ok(!scoreSetUpRun([...research, proposal({ name: "Full Story" })]).pass, "an entry defineMcpServers refuses fails");
ok(!scoreSetUpRun([...research, proposal(), proposal()]).pass, "two proposals fail");

console.log(`\n✓ set-up-tool-eval-scoring: ${passed} assertions passed`);
