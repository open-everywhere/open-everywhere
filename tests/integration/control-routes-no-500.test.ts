import { expect, test } from "vitest";

import { bootAgent, controlGet } from "./harness";

const SINCE = new Date(Date.now() - 3_600_000).toISOString();
const S = encodeURIComponent(SINCE);

const AUTH: ReadonlyArray<readonly [string, Record<string, string> | undefined]> = [
  ["read bearer", undefined],
  ["no header", {}],
  ["wrong bearer", { authorization: "Bearer not-a-token" }],
  ["empty bearer", { authorization: "Bearer " }],
  ["oauth-shaped jwt", { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln" }],
  ["basic", { authorization: "Basic dXNlcjpwYXNz" }],
  ["login cookie", { cookie: "session=abc; oe_login=1; _vercel_jwt=abc" }],
  ["proxy login headers", { "x-forwarded-user": "a@example.com", "x-forwarded-email": "a@example.com", "x-vercel-protection-bypass": "abc" }],
];

const GETS: readonly string[] = [
  `/control/v1/audit?since=${S}&limit=`,
  `/control/v1/audit?since=${S}&limit=5`,
  `/control/v1/audit?since=${S}&limit=abc`,
  `/control/v1/audit?since=${S}&limit=-1`,
  `/control/v1/audit?since=${S}&limit=99999999999999999999999`,
  `/control/v1/audit?since=${S}&limit=5&actions=a,b`,
  `/control/v1/audit?since=${S}&until=nope`,
  `/control/v1/audit?since=nope`,
  `/control/v1/audit?limit=5`,
  `/control/v1/audit`,
  `/control/v1/usage`,
  `/control/v1/usage?since=${S}`,
  `/control/v1/usage?since=${S}&workspaces=slack/T1`,
  `/control/v1/usage?since=${S}&workspaces=slack`,
  `/control/v1/usage?since=${S}&workspaces=slack/T1&sessionStartedAfter=nope`,
  `/control/v1/usage?since=nope&workspaces=slack/T1`,
  `/control/v1/usage?since=${S}&workspaces=%ZZ`,
  `/control/v1/tool-usage`,
  `/control/v1/tool-usage?since=${S}`,
  `/control/v1/tool-usage?since=${S}&by=nope`,
  `/control/v1/tool-usage?since=${S}&domain=no-such-domain`,
  `/control/v1/unified-audit`,
  `/control/v1/unified-audit?domain=no-such-domain`,
  `/control/v1/unified-audit?domain=no-such-domain&sinceDays=abc`,
  `/control/v1/runtime-signal`,
  `/control/v1/model-calls/sessions`,
  `/control/v1/session/wrun_none/model-calls?limit=abc`,
  `/control/v1/session/wrun_none/model-calls?body=0`,
  `/control/v1/session/wrun_none/transcript?startIndex=-1`,
  `/control/v1/session/wrun_none/transcript?idleMs=1`,
  `/control/v1/session/%E0%A4%A/transcript`,
  `/control/v1/session/%/model-calls`,
  `/eve/v1/oe/status`,
  `/eve/v1/oe/status?verbose=1`,
  `/eve/v1/health`,
  `/eve/v1/info`,
  `/control/v1/mcp`,
  `/control/v1/oauth/authorize?client_id=x`,
  `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/control/v1/mcp`,
];

const OTHERS: ReadonlyArray<{ method: string; path: string; contentType?: string; body?: string }> = [
  { method: "POST", path: "/control/v1/oauth/token" },
  { method: "POST", path: "/control/v1/oauth/token", contentType: "application/json", body: '{"grant_type":' },
  { method: "POST", path: "/control/v1/oauth/token", contentType: "application/x-www-form-urlencoded", body: "grant_type=" },
  { method: "POST", path: "/control/v1/oauth/token", contentType: "application/x-www-form-urlencoded", body: "grant_type=authorization_code" },
  { method: "POST", path: "/control/v1/mcp" },
  { method: "POST", path: "/control/v1/mcp", contentType: "application/json", body: '{"jsonrpc":' },
  { method: "DELETE", path: "/control/v1/mcp" },
  { method: "POST", path: "/control/v1/test/wake" },
  { method: "POST", path: "/control/v1/test/wake", contentType: "application/json", body: "not json" },
  { method: "POST", path: "/control/v1/secrets/adopt" },
  { method: "POST", path: "/control/v1/secrets/adopt", contentType: "application/json", body: '{"names":' },
];

test("every control route answers a bad or unexpected request below 500, under every auth header", async () => {
  const { base } = await bootAgent();
  const failures: string[] = [];
  const seen = new Map<string, number>();
  const send = async (method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { accept: "application/json, text/event-stream", ...headers },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: await res.text() };
  };

  for (const path of GETS) {
    for (const [name, headers] of AUTH) {
      const { status, body } = headers === undefined ? await controlGet(path) : await send("GET", path, headers);
      if (status >= 500) failures.push(`GET ${path} [${name}] -> ${status} ${body.slice(0, 160)}`);
      if (name === "read bearer") seen.set(path, status);
    }
  }
  for (const row of OTHERS) {
    for (const [name, headers] of AUTH) {
      if (headers === undefined) continue;
      const { status, body } = await send(row.method, row.path, { ...headers, ...(row.contentType ? { "content-type": row.contentType } : {}) }, row.body);
      if (status >= 500) failures.push(`${row.method} ${row.path} ${row.body ?? "(no body)"} [${name}] -> ${status} ${body.slice(0, 160)}`);
    }
  }
  console.log(`control-routes-no-500 (read bearer):\n${[...seen].map(([p, s]) => `${s} ${p}`).join("\n")}`);
  expect(failures, failures.join("\n")).toEqual([]);

  const pins: ReadonlyArray<readonly [string, number]> = [
    [`/control/v1/audit?since=${S}&limit=5`, 200],
    [`/control/v1/audit?since=${S}&limit=`, 200],
    [`/control/v1/audit?since=${S}&limit=abc`, 400],
    [`/control/v1/usage?since=${S}&workspaces=slack/T1`, 200],
    [`/control/v1/usage`, 400],
    [`/control/v1/tool-usage?since=${S}`, 200],
    [`/control/v1/tool-usage?since=${S}&by=nope`, 400],
    [`/control/v1/unified-audit`, 400],
    [`/control/v1/unified-audit?domain=no-such-domain`, 400],
    [`/control/v1/runtime-signal`, 200],
    [`/control/v1/model-calls/sessions`, 200],
    [`/control/v1/session/wrun_none/model-calls?body=0`, 200],
    [`/control/v1/session/wrun_none/transcript?idleMs=1`, 404],
    [`/control/v1/session/%E0%A4%A/transcript`, 400],
    [`/control/v1/session/%/model-calls`, 400],
    [`/eve/v1/oe/status`, 200],
  ];
  for (const [path, want] of pins) expect(seen.get(path), path).toBe(want);
}, 600_000);
