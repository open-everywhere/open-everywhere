import assert from "node:assert/strict";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import {
  browserHostProblems,
  defineBrowserHosts,
  browserEgressHosts,
  browserEvaluateHosts,
  browserHostDeclarations,
  isLoopbackBrowseHost,
  _setBrowserHostsForTest,
  resetBrowserHostsForTest,
  type BrowserHostDeclaration,
} from "../agent/access/browser-hosts.js";
import { GIT_BROKER_HOSTS } from "../agent/access/reserved-hosts.js";
import { assertEvaluateArmedFor, currentBrowseHost, registerBrowserToolkit, registeredBrowserToolkit, resetBrowseHostsForTest, resetBrowserToolkitForTest } from "../agent/access/browser-toolkit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const row = (extra: Partial<BrowserHostDeclaration> = {}): BrowserHostDeclaration => ({
  host: "qa.example.com",
  methods: ["GET", "HEAD"],
  why: "test fixture",
  ...extra,
});

{
  ok(browserHostProblems([row()]).length === 0, "CONTROL: a minimal valid row has no problems");
  ok(browserHostProblems([]).length > 0, "an EMPTY declaration is a problem — the capability needs at least one host (fail closed)");

  for (const [host, why] of [
    ["*.example.com", "wildcard"],
    ["https://example.com", "scheme"],
    ["example.com/path", "path"],
    ["example.com:8080", "port"],
    ["user@example.com", "credentials in the host"],
    ["169.254.169.254", "metadata IP"],
    ["10.0.0.5", "private-range IP"],
    ["intranet", "single dotless label"],
    ["example.c0m", "non-alphabetic TLD"],
    ["QA.Example.com", "upper case"],
    [" qa.example.com", "leading whitespace"],
    ["", "empty"],
  ] as const) {
    ok(browserHostProblems([row({ host })]).length > 0, `rejects ${why}: "${host}"`);
  }

  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "qa.example.com", "my-app.example.co"] as const) {
    ok(browserHostProblems([row({ host })]).length === 0, `accepts "${host}"`);
  }

  ok(browserHostProblems([row(), row()]).length > 0, "a host declared twice is a problem — one row per host, so its verbs and credential are unambiguous");
  ok(browserHostProblems([row({ methods: [] })]).length > 0, "an EMPTY method list is a problem — a browser host is a host+method row");
  ok(browserHostProblems([row({ methods: ["TRACE"] as unknown as BrowserHostDeclaration["methods"] })]).length > 0, "a non-HTTP verb is a problem");
  ok(browserHostProblems([row({ why: "  " })]).length > 0, "a blank `why` is a problem — the row is a reviewed security decision");
  ok(browserHostProblems([row({ credential: "" })]).length > 0, "an empty `credential` names no connection");
  ok(
    browserHostProblems([row({ host: "localhost", credential: "vendor-login" })]).length > 0,
    "a CREDENTIAL on a LOOPBACK row is refused — loopback never crosses the firewall, so there is no boundary at which to inject one",
  );
  ok(browserHostProblems([row({ host: "localhost" })]).length === 0, "CONTROL: the same loopback row without a credential is fine");

  for (const host of GIT_BROKER_HOSTS) {
    ok(
      browserHostProblems([row({ host, methods: ["GET"], credential: "acme-gh" })]).length > 0,
      `a credentialed row on the reserved broker host "${host}" is a problem`,
    );
    ok(
      browserHostProblems([row({ host })]).length > 0,
      `…and an UNCREDENTIALED row on "${host}" is too — the broker also displaces the verb narrowing, which is a control of its own`,
    );
  }
  const reservedProblems = browserHostProblems([row({ host: "github.com", credential: "acme-gh" })]);
  ok(
    reservedProblems.some((p) => p.includes("RESERVED by the git read-broker") && p.includes("checkout_repo")),
    "…and it names the reservation and the call that displaces the row, in the same words the bundle-side lint uses",
  );
  ok(
    browserHostProblems([row({ host: "*.github.com" })]).some((p) => p.includes("overlaps codeload.github.com")),
    "a wildcard covering a reserved host is reserved too, and the message names the host it overlaps",
  );
  ok(
    browserHostProblems([row({ host: "api.github.com", credential: "acme-gh" })]).length === 0,
    "🔴 CONTROL: `api.github.com` is NOT reserved — the broker never touches it, so a credentialed row there is fine",
  );
  ok(browserHostProblems([row({ host: "github.com.example.com" })]).length === 0, "CONTROL: a host that merely CONTAINS a reserved name is not reserved");

  assert.throws(() => defineBrowserHosts([row({ host: "github.com" })]), /RESERVED by the git read-broker/, "a reserved row fails the BOOT, like every other bad row");
  n++;

  ok(isLoopbackBrowseHost("localhost") && isLoopbackBrowseHost("127.0.0.9") && isLoopbackBrowseHost("::1"), "loopback classifier");
  ok(!isLoopbackBrowseHost("qa.example.com") && !isLoopbackBrowseHost("128.0.0.1"), "loopback classifier: negative control");
}

{
  assert.throws(() => defineBrowserHosts([row({ host: "*.example.com" })]), /wildcards are not supported/, "one bad row throws");
  n++;
  const frozen = defineBrowserHosts([row()]);
  ok(Object.isFrozen(frozen) && Object.isFrozen(frozen[0]), "a validated declaration is frozen — nothing mutates it after boot");
}

{
  overrideSettingsForTest({ browser: { enabled: true } });
  _setBrowserHostsForTest([
    row({ host: "localhost", methods: ["GET", "POST"] }),
    row({ host: "qa.example.com" }),
    row({ host: "vendor.example.com", methods: ["GET", "HEAD", "POST"], credential: "vendor-login", evaluate: true }),
  ]);
  ok(browserHostDeclarations().length === 3, "the registered declaration reads back whole");
  ok(
    browserEgressHosts().map((h) => h.host).join("|") === "qa.example.com|vendor.example.com",
    "browserEgressHosts drops loopback — it never crosses the firewall, so claiming it on the outer wall would claim something false",
  );
  ok([...browserEvaluateHosts()].join("|") === "vendor.example.com", "browserEvaluateHosts names ONLY the rows that opted in");

  overrideSettingsForTest({ browser: { enabled: false } });
  ok(browserEgressHosts().length === 0, "flag OFF ⇒ no declared host crosses the firewall");
  ok(browserEvaluateHosts().size === 0, "flag OFF ⇒ no host arms page scripting");
  ok(browserHostDeclarations().length === 3, "…while the raw declaration is unchanged — it records what the operator wrote, not what is armed");
  resetSettingsForTest();

  resetBrowserHostsForTest();
  ok(browserHostDeclarations().length === 0 && browserEvaluateHosts().size === 0, "reset returns to the unarmed state");
}

{
  overrideSettingsForTest({ browser: { enabled: true } });
  resetBrowserToolkitForTest();
  resetBrowseHostsForTest();
  _setBrowserHostsForTest([row({ host: "armed.example.com", evaluate: true }), row({ host: "plain.example.com" })]);

  const calls: unknown[] = [];
  let nextUrl: string | null = null;
  const entry: { description: string; inputSchema: unknown; execute: (input: unknown) => unknown } = {
    description: "stub",
    inputSchema: {},
    execute: (input: unknown) => {
      calls.push(input);
      return nextUrl === null ? { ok: true } : { url: nextUrl };
    },
  };
  registerBrowserToolkit({ browser_navigate: entry, browser_evaluate: entry, browser_click: entry, browser_tabs: entry });
  const kit = registeredBrowserToolkit()!;
  ok(kit["browser_evaluate"] !== undefined, "wall 1: an armed host mounts browser_evaluate");

  const ctxFor = (id: string) => ({ session: { id, auth: { current: { attributes: { oe_grain: "task" } } } } });
  const run = (name: string, input: unknown, ctx: unknown) => (kit[name]!.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, ctx);

  const a = ctxFor("session-a");
  await assert.rejects(() => run("browser_evaluate", { expression: "1" }, a), /no page host is known/, "wall 2: evaluate with NO navigation is refused (fail closed)");
  n++;
  ok(calls.length === 0, "the refused evaluate never reached the vendor — nothing was scripted");

  nextUrl = null;
  await run("browser_navigate", { action: "goto", url: "https://plain.example.com:8443/x" }, a);
  ok(currentBrowseHost(a) === "plain.example.com", "the tracker takes the host from the navigate INPUT, with the port stripped");
  await assert.rejects(() => run("browser_evaluate", { expression: "1" }, a), /does not declare/, "wall 2: a declared host that did NOT opt in is refused");
  n++;

  await run("browser_navigate", { action: "goto", url: "https://armed.example.com/y" }, a);
  const before = calls.length;
  await run("browser_evaluate", { expression: "1" }, a);
  ok(calls.length === before + 1, "wall 2: on an ARMED host the evaluate runs — the positive control");

  nextUrl = "https://plain.example.com/moved";
  await run("browser_click", { ref: "@e1" }, a);
  ok(currentBrowseHost(a) === "plain.example.com", "a later result's URL refreshes the tracker");
  await assert.rejects(() => run("browser_evaluate", { expression: "1" }, a), /does not declare/, "and wall 2 follows it — evaluate is refused after the move");
  n++;

  nextUrl = null;
  const textResult = { text: "see https://armed.example.com/ for details", nodes: ["a11y"] };
  entry.execute = (input: unknown) => {
    calls.push(input);
    return textResult;
  };
  await run("browser_click", { ref: "@e2" }, a);
  ok(currentBrowseHost(a) === "plain.example.com", "a result whose page TEXT names an armed host does NOT move the tracker (structured url/href only)");
  await assert.rejects(() => run("browser_evaluate", { expression: "1" }, a), /does not declare/, "…so wall 2 still refuses — page text cannot arm page scripting");
  n++;

  entry.execute = (input: unknown) => {
    calls.push(input);
    return { ok: true };
  };
  await run("browser_navigate", { action: "goto", url: "https://armed.example.com/" }, a);
  await run("browser_tabs", { action: "new", url: "https://plain.example.com/t" }, a);
  ok(currentBrowseHost(a) === "plain.example.com", "browser_tabs({action:\"new\", url}) moves the tracker — a second real navigation seam");
  await assert.rejects(() => run("browser_evaluate", { expression: "1" }, a), /does not declare/, "…so a new tab on an unarmed host does not inherit the previous page's arming");
  n++;

  const b = ctxFor("session-b");
  ok(currentBrowseHost(b) === undefined, "a second session does NOT inherit the first session's page host");

  resetBrowseHostsForTest();
  resetBrowserToolkitForTest();
  resetBrowserHostsForTest();
}

{
  overrideSettingsForTest({ browser: { enabled: true } });
  resetBrowserToolkitForTest();
  _setBrowserHostsForTest([row({ host: "plain.example.com" })]);
  const entry = { description: "stub", inputSchema: {}, execute: () => ({ ok: true }) };
  registerBrowserToolkit({ browser_navigate: entry, browser_evaluate: entry });
  ok(registeredBrowserToolkit()!["browser_evaluate"] === undefined, "wall 1: with no host armed, browser_evaluate is not in the kit at all");
  ok(registeredBrowserToolkit()!["browser_navigate"] !== undefined, "the rest of the snapshot-driven kit is unaffected");

  assert.throws(() => assertEvaluateArmedFor({ session: { id: "no-nav" } }), /no page host is known/, "assertEvaluateArmedFor refuses an unknown host");
  n++;

  resetBrowserToolkitForTest();
  resetBrowserHostsForTest();
  resetSettingsForTest();
}

console.log(`\n✓ browser-hosts: ${n} assertions passed (declaration lint + fail-closed boot + derived views + the two browser_evaluate walls)\n`);
