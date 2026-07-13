import {
  unifiedDomainSessionKey,
  unifiedSupervisorToken,
} from "../../agent/channels/unified-supervisor.js";
import { registerOperationalPostgres, getOperationalStore } from "../../agent/operational/provider.js";
import type { PgClient } from "../../agent/operational/postgres.js";

async function main() {
  const domain = process.argv[2];
  const org = process.argv[3] ?? process.env.E2E_ORG ?? "default";
  if (!domain) {
    console.error("usage: rotate-window.ts <domain> [org]");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required (a live Neon connection string)");
    process.exit(1);
  }

  const pkg = "@neondatabase/serverless";
  const { neon } = (await import(pkg)) as {
    neon: (url: string) => { query(text: string, params?: unknown[]): Promise<unknown> };
  };
  const sql = neon(dbUrl);
  const client: PgClient = {
    query: async (text, params) => ({ rows: (await sql.query(text, (params ?? []) as unknown[])) as unknown[] }),
  };

  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  registerOperationalPostgres(client);
  const store = getOperationalStore();

  const key = unifiedDomainSessionKey(domain);
  const cur = await store.getChannelSession(org, key);
  const generation = Date.now();
  const newToken = unifiedSupervisorToken(domain, generation);

  const row = await store.rotateChannelSession(org, key, newToken, new Date().toISOString());

  console.log("=== rotate-window ===");
  console.log(`org:            ${org}`);
  console.log(`domain:         ${domain}`);
  console.log(`registry key:   ${key}`);
  console.log(`old generation: ${cur ? cur.generation : "none (no prior row)"}`);
  console.log(`old token:      ${cur?.token ?? "none"}`);
  console.log(`minted generation (in token): ${generation}`);
  console.log(`NEW token:      ${row.token}   <- eve session key (never seen before ⇒ fresh window)`);
  console.log(`row int counter: ${row.generation}   (separate bookkeeping, not the eve key)`);
  console.log(`createdAt:      ${row.createdAt}`);
  console.log(`handoffNote:    ${row.handoffNote ?? "null (empty window ✓)"}`);
  if (row.token !== newToken) {
    console.error(`WARN: stored token ${row.token} != minted ${newToken}`);
  }
}

main().catch((e) => {
  console.error("ROTATE FAILED:", e);
  process.exit(1);
});
