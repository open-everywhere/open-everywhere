import { PGlite } from "@electric-sql/pglite";

export interface TestPgClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface TestPg {
  readonly client: TestPgClient;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const opened: TestPg[] = [];

let dbCounter = 0;

export async function openTestPg(): Promise<TestPg> {
  const url = process.env.OE_TEST_PG_URL?.trim();
  const pg = url ? await openRealPg(url) : openPglite();
  opened.push(pg);
  return pg;
}

export async function closeAllTestPg(): Promise<void> {
  const batch = opened.splice(0, opened.length);
  await Promise.all(batch.map((pg) => pg.close()));
}

function openPglite(): TestPg {
  const db = new PGlite();
  return {
    client: { query: (text, params) => db.query(text, params ? [...params] : undefined) },
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

interface RealPgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}
interface NeonConfigShape {
  wsProxy?: (host: string, port: number) => string;
  useSecureWebSocket?: boolean;
  pipelineTLS?: boolean;
  pipelineConnect?: boolean | "password";
  webSocketConstructor?: unknown;
}

function configureLocalWsProxy(neonConfig: NeonConfigShape): void {
  const proxy = process.env.OE_TEST_PG_WS?.trim();
  if (!proxy) return;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  if (!neonConfig.webSocketConstructor && typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined") {
    neonConfig.webSocketConstructor = (globalThis as { WebSocket: unknown }).WebSocket;
  }
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function openRealPg(adminUrl: string): Promise<TestPg> {
  const pkg = "@neondatabase/serverless";
  const mod = (await import(pkg)) as {
    Client: new (cfg: { connectionString: string }) => RealPgClient;
    neonConfig: NeonConfigShape;
  };
  configureLocalWsProxy(mod.neonConfig);

  const admin = new mod.Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `oe_test_${Date.now().toString(36)}_${(dbCounter++).toString(36)}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const client = new mod.Client({ connectionString: withDatabase(adminUrl, name) });
  await client.connect();

  return {
    client: { query: (text, params) => client.query(text, params) },
    exec: async (sql) => {
      await client.query(sql);
    },
    async close() {
      await client.end();
      const dropper = new mod.Client({ connectionString: adminUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}
