import { createServer, type Server } from "node:net";

export interface ReservedPort {
  readonly port: number;
  release(): Promise<void>;
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
      let released = false;
      resolve({
        port: address.port,
        release: () =>
          new Promise<void>((res) => {
            if (released) {
              res();
              return;
            }
            released = true;
            srv.close(() => res());
          }),
      });
    });
    srv.listen(0, host);
  });
}
