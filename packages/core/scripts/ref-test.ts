import {
  dbCredentialRef,
  parseDbCredentialRef,
  DB_REF_PREFIX,
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

ok(dbCredentialRef("notion", "team-key") === "db:notion:team-key", "derive: db:<connector>:<credential>");
ok(dbCredentialRef("e2e-intake", "e2e-key") === "db:e2e-intake:e2e-key", "derive: hyphenated ids survive");
ok(dbCredentialRef("notion", "team-key").startsWith(DB_REF_PREFIX), "derive: carries the db: prefix");

throwsWith(() => dbCredentialRef("", "x"), "non-empty", "derive: empty connector refused");
throwsWith(() => dbCredentialRef("x", ""), "non-empty", "derive: empty credential refused");
throwsWith(() => dbCredentialRef("a:b", "c"), "delimiter", "derive: colon in connector refused");
throwsWith(() => dbCredentialRef("a", "b:c"), "delimiter", "derive: colon in credential refused");

const p = parseDbCredentialRef("db:notion:team-key");
ok(p?.connector === "notion" && p?.credentialId === "team-key", "parse: recovers connector + credentialId");

for (const [prov, cred] of [["notion", "team-key"], ["e2e-intake", "e2e-key"], ["a", "b"]] as const) {
  const ref = dbCredentialRef(prov, cred);
  const back = parseDbCredentialRef(ref);
  ok(back?.connector === prov && back?.credentialId === cred, `round-trip: ${ref}`);
}

ok(parseDbCredentialRef("NOTION_API_KEY") === null, "parse: an env-var-name ref → null");
ok(parseDbCredentialRef("db:notion") === null, "parse: missing credential segment → null");
ok(parseDbCredentialRef("db::x") === null, "parse: empty connector segment → null");
ok(parseDbCredentialRef("db:notion:") === null, "parse: empty credential segment → null");
ok(parseDbCredentialRef("db:a:b:c") === null, "parse: extra colon (four segments) → null");
ok(parseDbCredentialRef("") === null, "parse: empty string → null");

console.log(`✓ ref: ${passed} assertions passed`);
