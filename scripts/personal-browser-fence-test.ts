import assert from "node:assert/strict";
import { checkedAddress, hostAllowed, internalBlockList, isInternalAddress, parseAllow } from "../deploy/personal-browser/fence.mjs";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const ALL = ["*"];
const block = internalBlockList(["10.9.8.7", "fd00::7"]);
const resolver = (table: Record<string, string[]>) => async (name: string): Promise<{ address: string; family: number }[]> => {
  if (!(name in table)) throw new Error("ENOTFOUND");
  return table[name]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

ok(JSON.stringify(parseAllow('[" Mail.Example.com ", 3, ""]')) === '["mail.example.com"]', "OE_PB_ALLOW is read lower-cased and trimmed, non-strings dropped");
ok(parseAllow("not json").length === 0, "a malformed list admits nothing");
ok(hostAllowed("mail.example.com", ["mail.example.com"]) && !hostAllowed("evil.example.com", ["mail.example.com"]), "an exact name admits that name only");
ok(hostAllowed("a.docs.example", ["*.docs.example"]) && !hostAllowed("docs.example", ["*.docs.example"]) && !hostAllowed("docs.example.evil", ["*.docs.example"]), "a wildcard admits subdomains only, never a look-alike");
ok(hostAllowed("mail.example.com.", ["mail.example.com"]), "a trailing dot is the same name");
ok(hostAllowed("anything.example", ALL), "a catch-all admits any name");

for (const a of ["127.0.0.1", "127.9.9.9", "0.0.0.0", "169.254.169.254", "::1", "0:0:0:0:0:0:0:1", "::", "::0", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "fe80::1", "::ffff:169.254.169.254", "10.9.8.7", "fd00::7"]) {
  ok(isInternalAddress(a, block), `🔴 ${a} is internal`);
}
for (const a of ["93.184.216.34", "2606:2800:220:1::1", "10.0.0.1", "192.168.1.1"]) {
  ok(!isInternalAddress(a, block), `${a} is not internal (a public or private address the list may admit)`);
}
ok(isInternalAddress("not-an-ip", block), "a non-address fails closed");

const table: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "rebind.example": ["93.184.216.34", "127.0.0.1"],
  "metadata.example": ["169.254.169.254"],
  "self.example": ["10.9.8.7"],
  "mapped.example": ["::ffff:7f00:1"],
};
const opts = { block, lookup: resolver(table) };
ok((await checkedAddress("public.example", ALL, opts)) === "93.184.216.34", "a public name is admitted and resolves to the address the proxy will connect to");
ok((await checkedAddress("93.184.216.34", ALL, opts)) === "93.184.216.34", "a public literal is admitted as it is");
for (const [host, why] of ([
  ["localhost", "a loopback name"],
  ["localhost.", "a loopback name with a trailing dot"],
  ["api.localhost", "a .localhost name"],
  ["127.0.0.1", "a loopback literal"],
  ["[::1]", "a bracketed IPv6 loopback"],
  ["[::ffff:7f00:1]", "the hex IPv4-mapped loopback the URL parser produces"],
  ["169.254.169.254", "the metadata endpoint"],
  ["rebind.example", "a name with ONE loopback answer among public ones"],
  ["metadata.example", "a name that resolves to the metadata endpoint"],
  ["self.example", "a name that resolves to the box's own interface"],
  ["mapped.example", "a name that resolves to a mapped loopback"],
  ["unknown.example", "a name that does not resolve"],
] as [string, string][])) {
  ok((await checkedAddress(host, ALL, opts)) === undefined, `🔴 refused under *: ${why} (${host})`);
}
ok((await checkedAddress("public.example", ["other.example"], opts)) === undefined, "a name off the list is refused before any lookup");

let calls = 0;
const flip = async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
ok((await checkedAddress("flip.example", ALL, { block, lookup: flip })) === "93.184.216.34" && calls === 1, "the name is resolved ONCE; the proxy connects to that checked address");

console.log(`✓ personal-browser-fence-test: ${n} assertions`);
