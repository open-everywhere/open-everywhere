const http = require("node:http");

const CONTROL_HOST = process.env.OE_EGRESS_CONTROL_HOST_INTERNAL || "127.0.0.1";
const CONTROL_PORT = Number(process.env.OE_EGRESS_CONTROL_PORT || 8080);

function query(src, host, method, path) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({ src: src || "", host: host || "", method: method || "", path: path || "" });
    const req = http.request(
      { host: CONTROL_HOST, port: CONTROL_PORT, path: `/acl?${qs.toString()}`, method: "GET", timeout: 2000 },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ allow: false });
          }
        });
      },
    );
    req.on("error", () => resolve({ allow: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ allow: false });
    });
    req.end();
  });
}

function esc(v) {
  return String(v).replace(/"/g, '\\"');
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parts = trimmed.split(/\s+/);
  const id = parts.shift();
  const [src, host, rawMethod, path] = parts;
  const method = rawMethod && rawMethod.toUpperCase() === "CONNECT" ? "" : rawMethod;
  const decision = await query(dec(src), dec(host), dec(method), dec(path));
  if (decision && decision.allow) {
    let extra = "";
    if (decision.headers && decision.headers.authorization) {
      extra = ` authz="${esc(decision.headers.authorization)}"`;
    } else if (decision.headers && decision.headers.Authorization) {
      extra = ` authz="${esc(decision.headers.Authorization)}"`;
    }
    process.stdout.write(`${id} OK${extra}\n`);
  } else {
    process.stdout.write(`${id} ERR message="denied by open-everywhere egress policy"\n`);
  }
}

function dec(v) {
  if (v === undefined) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

let backlog = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  backlog += chunk;
  let nl;
  while ((nl = backlog.indexOf("\n")) >= 0) {
    const line = backlog.slice(0, nl);
    backlog = backlog.slice(nl + 1);
    void handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
