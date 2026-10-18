import { createServer, Server } from "node:net";

export const HANDOFF_TIMEOUT_MS = 60_000;

export const HANDOFF_MISSED_PREFIX = "bindListenerOnReservation: no listen() call named the reserved port";

export interface ReservedPort {
  readonly port: number;
  release(): Promise<void>;
  bindListenerOnReservation<T>(bind: () => Promise<T>, timeoutMs?: number): Promise<T>;
  adoptedListener(): Server | undefined;
}

function listenPort(args: readonly unknown[]): number | undefined {
  const first = args[0];
  if (typeof first === "number") return first;
  if (typeof first === "string" && /^\d+$/.test(first)) return Number(first);
  if (first !== null && typeof first === "object" && "port" in first) {
    const port = Number((first as { port: unknown }).port);
    return Number.isInteger(port) ? port : undefined;
  }
  return undefined;
}

export function reserveEphemeralPort(host = "127.0.0.1"): Promise<ReservedPort> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("reserveEphemeralPort: the OS returned no address for the listening socket.")));
        return;
      }
      const port = address.port;
      let released = false;
      let handoffStarted = false;
      let adopter: Server | undefined;
      const release = (): Promise<void> =>
        new Promise<void>((res) => {
          if (released) {
            res();
            return;
          }
          released = true;
          srv.close(() => res());
        });
      resolve({
        port,
        release,
        adoptedListener: () => adopter,
        async bindListenerOnReservation<T>(bind: () => Promise<T>, timeoutMs = HANDOFF_TIMEOUT_MS): Promise<T> {
          if (handoffStarted || released) throw new Error("bindListenerOnReservation: this reservation is already released or handed off.");
          handoffStarted = true;
          const original = Server.prototype.listen;
          let handedOff!: () => void;
          const adopted = new Promise<void>((res) => (handedOff = res));
          const handle = (srv as unknown as { _handle: unknown })._handle;
          const intercept = function (this: Server, ...args: unknown[]): Server {
            if (released || listenPort(args) !== port) return (original as (...a: unknown[]) => Server).apply(this, args);
            if (Server.prototype.listen === intercept) Server.prototype.listen = original;
            released = true;
            adopter = this;
            (srv as unknown as { _handle: unknown })._handle = null;
            handedOff();
            const callback = args.findLast((a) => typeof a === "function");
            return callback === undefined ? original.call(this, { _handle: handle }) : original.call(this, { _handle: handle }, callback as () => void);
          } as typeof Server.prototype.listen;
          Server.prototype.listen = intercept;
          try {
            const value = await bind();
            let timer: NodeJS.Timeout | undefined;
            const missed = new Promise<"missed">((res) => (timer = setTimeout(() => res("missed"), timeoutMs)));
            const outcome = await Promise.race([adopted.then(() => "adopted" as const), missed]);
            clearTimeout(timer);
            if (outcome === "missed") {
              throw new Error(
                `${HANDOFF_MISSED_PREFIX} (${port}) within ${timeoutMs} ms of the bind resolving. The real listener ` +
                  "never adopted the reserved socket, so the bundle no longer binds through Server#listen with the " +
                  "PORT it was given. Read scripts/ephemeral-port.ts (OPE-2555).",
              );
            }
            return value;
          } finally {
            if (Server.prototype.listen === intercept) Server.prototype.listen = original;
            await release();
          }
        },
      });
    });
    srv.listen(0, host);
  });
}
