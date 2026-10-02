import { expect, test } from "vitest";

import { bootAgent } from "./harness";

const CONTRACT_IDS = [
  "node-24",
  "public-https-url",
  "postgres",
  "sandbox-backend",
  "egress-control",
  "model-route",
  "secrets",
  "workflow-storage",
] as const;

interface StatusBody {
  contract: number;
  version: { app: string | null; core: string | null; eve: string | null };
  host: string;
  requirements: { id: string; met: string; detail: string }[];
  surfaces: Record<string, { credentials: string; installed: string; eventsVerified: string }>;
  checkedAt: string;
}

test("the status route is mounted, answers every contract requirement, and leaks nothing", async () => {
  const { base } = await bootAgent();

  const res = await fetch(`${base}/eve/v1/oe/status`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");

  const body = (await res.json()) as StatusBody;
  const raw = JSON.stringify(body);

  expect(body.requirements.map((r) => r.id)).toEqual([...CONTRACT_IDS]);
  for (const r of body.requirements) {
    expect(["yes", "no", "unknown"]).toContain(r.met);
    expect(r.detail.length).toBeGreaterThan(0);
  }
  expect(body.contract).toBeGreaterThanOrEqual(1);
  expect(Date.parse(body.checkedAt)).not.toBeNaN();

  expect(body.host).not.toBe("vercel");
  const byId = new Map(body.requirements.map((r) => [r.id, r]));
  expect(byId.get("postgres")!.met).toBe("no");
  expect(byId.get("postgres")!.detail).toMatch(/PGlite|embedded/i);
  expect(byId.get("postgres")!.detail).not.toMatch(/answered a read|did not answer a read/);
  expect(byId.get("node-24")!.met).toBe("yes");
  expect(body.version.eve).toMatch(/^\d+\.\d+\.\d+/);
  expect(body.version.app).toBe("unversioned");
  expect(byId.get("workflow-storage")!.met).toBe("unknown");

  expect(Object.keys(body.surfaces)).toContain("slack");
  const slack = body.surfaces["slack"]!;
  for (const field of ["credentials", "installed", "eventsVerified"] as const) {
    expect(["yes", "no", "unknown"]).toContain(slack[field]);
  }

  for (const name of [
    "OE_CREDENTIAL_ENCRYPTION_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "AI_GATEWAY_API_KEY",
    "OE_EGRESS_PROXY_URL",
    "OE_PGLITE_DIR",
    "OE_MEMORY_DIR",
    "OE_SQLITE_PATH",
  ]) {
    const value = process.env[name];
    if (value !== undefined && value.length > 3) expect(raw).not.toContain(value);
  }
  expect(raw).not.toMatch(/"[^"]*\/(tmp|home|var)\//);
  expect(raw).not.toMatch(/xoxb-|postgres:\/\//);
});
