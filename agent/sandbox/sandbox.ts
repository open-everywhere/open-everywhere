import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const TIMEOUT_MS = intFromEnv("OE_SANDBOX_TIMEOUT_MS", 30 * 60 * 1000);
const SNAPSHOT_EXPIRATION_MS = intFromEnv("OE_SANDBOX_SNAPSHOT_EXPIRATION_MS", 7 * 24 * 60 * 60 * 1000);

export default defineSandbox({
  backend: vercel({
    timeout: TIMEOUT_MS,
    snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
    keepLastSnapshots: { count: 1, deleteEvicted: true },
  }),
});
