import assert from "node:assert/strict";
import net from "node:net";
import { checkedAddress, hostAllowed, internalBlockList, isInternalAddress, parseAllow, parseUpstream, upstreamTarget, upstreamTunnel } from "../deploy/personal-browser/fence.mjs";

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

ok(upstreamTarget("mail.example.com", ["mail.example.com"], block) === "mail.example.com", "behind the proxy, a listed name is asked of the proxy by NAME");
ok(upstreamTarget("Mail.Example.com.", ["mail.example.com"], block) === "mail.example.com", "behind the proxy, the name is normalised before the ask");
for (const [host, allow, why] of [
  ["evil.example", ["mail.example.com"], "a name off the list"],
  ["localhost", ALL, "a loopback name under a catch-all"],
  ["api.localhost", ALL, "a .localhost name under a catch-all"],
  ["127.0.0.1", ALL, "a loopback literal under a catch-all"],
  ["169.254.169.254", ALL, "the metadata endpoint literal under a catch-all"],
  ["10.9.8.7", ALL, "the box's own interface literal under a catch-all"],
] as [string, string[], string][]) {
  ok(upstreamTarget(host, allow, block) === undefined, `🔴 behind the proxy, refused before the ask: ${why} (${host})`);
}
ok(upstreamTarget("93.184.216.34", ALL, block) === "93.184.216.34", "behind the proxy, a public literal on the list is asked as it is");
ok(JSON.stringify(parseUpstream("http://oe-egress-proxy:3128")) === '{"host":"oe-egress-proxy","port":3128}', "the upstream origin parses to host and port");
ok(parseUpstream("https://p:1") === undefined && parseUpstream("oe-egress-proxy:3128") === undefined && parseUpstream("") === undefined, "an upstream that is not an http:// origin is refused");

const seen: string[] = [];
const fake = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (c) => {
    buf += c.toString("latin1");
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const line = buf.slice(0, buf.indexOf("\r\n"));
    seen.push(line);
    if (line === "CONNECT mail.example.com:443 HTTP/1.1") {
      sock.write("HTTP/1.1 200 Connection established\r\n\r\nhello");
    } else {
      sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const fakePort = (fake.address() as net.AddressInfo).port;
const tunnel = await upstreamTunnel({ host: "127.0.0.1", port: fakePort }, "mail.example.com", 443);
ok(tunnel !== undefined, "the tunnel opens on the proxy's 200");
ok(tunnel!.head.toString() === "hello", "bytes that came with the proxy's 200 come back as the head, for the page (none are lost in the header read)");
tunnel!.socket.destroy();
ok((await upstreamTunnel({ host: "127.0.0.1", port: fakePort }, "evil.example", 443)) === undefined, "🔴 the tunnel refuses when the proxy answers 403");
ok(seen.includes("CONNECT evil.example:443 HTTP/1.1"), "the refused host was asked of the proxy, which decided it");
fake.close();

console.log(`✓ personal-browser-fence-test: ${n} assertions`);
