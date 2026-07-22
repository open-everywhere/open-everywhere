import {
  dbCredentialRef,
  parseDbCredentialRef,
  DB_REF_PREFIX,
  executorCredentialRef,
  parseExecutorCredentialRef,
  EXECUTOR_REF_PREFIX,
} from "../agent/credentials/ref.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

ok(dbCredentialRef("notion", "team-key") === "db:notion:team-key", "derive: db:<provider>:<credential>");
ok(dbCredentialRef("e2e-intake", "e2e-key") === "db:e2e-intake:e2e-key", "derive: hyphenated ids survive");
ok(dbCredentialRef("notion", "team-key").startsWith(DB_REF_PREFIX), "derive: carries the db: prefix");

throwsWith(() => dbCredentialRef("", "x"), "non-empty", "derive: empty provider refused");
throwsWith(() => dbCredentialRef("x", ""), "non-empty", "derive: empty credential refused");
throwsWith(() => dbCredentialRef("a:b", "c"), "delimiter", "derive: colon in provider refused");
throwsWith(() => dbCredentialRef("a", "b:c"), "delimiter", "derive: colon in credential refused");

const p = parseDbCredentialRef("db:notion:team-key");
ok(p?.provider === "notion" && p?.credentialId === "team-key", "parse: recovers provider + credentialId");

for (const [prov, cred] of [["notion", "team-key"], ["e2e-intake", "e2e-key"], ["a", "b"]] as const) {
  const ref = dbCredentialRef(prov, cred);
  const back = parseDbCredentialRef(ref);
  ok(back?.provider === prov && back?.credentialId === cred, `round-trip: ${ref}`);
}

ok(parseDbCredentialRef("NOTION_API_KEY") === null, "parse: an env-var-name ref → null");
ok(parseDbCredentialRef("db:notion") === null, "parse: missing credential segment → null");
ok(parseDbCredentialRef("db::x") === null, "parse: empty provider segment → null");
ok(parseDbCredentialRef("db:notion:") === null, "parse: empty credential segment → null");
ok(parseDbCredentialRef("db:a:b:c") === null, "parse: extra colon (four segments) → null");
ok(parseDbCredentialRef("") === null, "parse: empty string → null");

ok(
  executorCredentialRef("notion-mcp", "org", "oe-notion-team-key") === "executor:notion-mcp:org:oe-notion-team-key",
  "executor derive: executor:<integration>:<owner>:<connection>",
);
ok(executorCredentialRef("a", "b", "c").startsWith(EXECUTOR_REF_PREFIX), "executor derive: carries the executor: prefix");

throwsWith(() => executorCredentialRef("", "b", "c"), "non-empty", "executor derive: empty integration refused");
throwsWith(() => executorCredentialRef("a", "", "c"), "non-empty", "executor derive: empty owner refused");
throwsWith(() => executorCredentialRef("a", "b", ""), "non-empty", "executor derive: empty connection refused");
throwsWith(() => executorCredentialRef("a:b", "c", "d"), "delimiter", "executor derive: colon in integration refused");
throwsWith(() => executorCredentialRef("a", "b:c", "d"), "delimiter", "executor derive: colon in owner refused");
throwsWith(() => executorCredentialRef("a", "b", "c:d"), "delimiter", "executor derive: colon in connection refused");

const e = parseExecutorCredentialRef("executor:notion-mcp:org:oe-notion-team-key");
ok(e?.integration === "notion-mcp" && e?.owner === "org" && e?.connection === "oe-notion-team-key", "executor parse: recovers integration/owner/connection");
for (const [i, o, c] of [["notion-mcp", "org", "oe-k"], ["x", "U123", "oe-c"], ["a", "b", "c"]] as const) {
  const ref = executorCredentialRef(i, o, c);
  const back = parseExecutorCredentialRef(ref);
  ok(back?.integration === i && back?.owner === o && back?.connection === c, `executor round-trip: ${ref}`);
}

ok(parseExecutorCredentialRef("db:notion:team-key") === null, "executor parse: a db ref → null (db path, not executor)");
ok(parseExecutorCredentialRef("executor:a:b") === null, "executor parse: too few segments → null");
ok(parseExecutorCredentialRef("executor:a:b:c:d") === null, "executor parse: too many segments → null");
ok(parseExecutorCredentialRef("executor::b:c") === null, "executor parse: empty integration segment → null");
ok(parseExecutorCredentialRef("executor:a:b:") === null, "executor parse: empty connection segment → null");
ok(parseExecutorCredentialRef("NOTION_API_KEY") === null, "executor parse: an env-var-name ref → null");
ok(parseExecutorCredentialRef("") === null, "executor parse: empty string → null");

ok(parseDbCredentialRef("executor:a:b:c") === null && parseExecutorCredentialRef("db:a:b") === null, "grammars are disjoint (a ref routes to exactly one storage path)");

console.log(`✓ ref: ${passed} assertions passed`);
