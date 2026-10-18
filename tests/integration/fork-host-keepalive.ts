import { Server as HttpServer } from "node:http";

export function giveIdleCloseToClient(listener: unknown): void {
  if (!(listener instanceof HttpServer)) {
    throw new Error(
      "fork-host-keepalive: the fork host's listener is not a node:http Server, so its keep-alive policy cannot be set. " +
        "The bundle no longer listens through http.createServer (srvx's Node adapter). Read tests/integration/fork-host-keepalive.ts (OPE-2586).",
    );
  }
  listener.keepAliveTimeout = 0;
}
