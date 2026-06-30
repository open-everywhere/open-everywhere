import {
  defineInteractiveAuthorization,
  type ConnectionAuthDefinition,
  type InteractiveAuthorizationDefinition,
  type JsonValue,
} from "eve/connections";
import { assertConnectorGranted } from "../access/connector-scope.js";
import { getSecret } from "../access/credentials.js";

export function appStaticToken(opts: {
  readonly connector: string;
  readonly secretRef: string;
}): ConnectionAuthDefinition {
  return {
    principalType: "app",
    async getToken() {
      await assertConnectorGranted(opts.connector);
      return { token: await getSecret(opts.secretRef) };
    },
  };
}

export function appConnectToken(opts: {
  readonly connector: string;
  readonly vercelConnector: string;
}): ConnectionAuthDefinition {
  let connectAuth: Promise<ConnectionAuthDefinition> | undefined;
  const load = (): Promise<ConnectionAuthDefinition> =>
    (connectAuth ??= (async () => {
      try {
        const spec = "@vercel/connect" + "/eve";
        const mod = (await import(spec)) as { connect(o: { connector: string }): ConnectionAuthDefinition };
        return mod.connect({ connector: opts.vercelConnector });
      } catch {
        throw new Error(
          `connection "${opts.connector}": service OAuth needs @vercel/connect (LIVE-ONLY). ` +
            `Install it + link a Vercel project, or use appStaticToken for a fixed key.`,
        );
      }
    })());
  return {
    principalType: "app",
    async getToken(o) {
      await assertConnectorGranted(opts.connector);
      const base = await load();
      return (base as { getToken(o: unknown): unknown }).getToken(o) as ReturnType<
        NonNullable<ConnectionAuthDefinition>["getToken"]
      >;
    },
  };
}

export function userInteractiveOAuth<Resume extends JsonValue = JsonValue>(opts: {
  readonly connector: string;
  readonly getToken: InteractiveAuthorizationDefinition<Resume>["getToken"];
  readonly startAuthorization: InteractiveAuthorizationDefinition<Resume>["startAuthorization"];
  readonly completeAuthorization: InteractiveAuthorizationDefinition<Resume>["completeAuthorization"];
  readonly displayName?: string;
  readonly evict?: InteractiveAuthorizationDefinition<Resume>["evict"];
}): InteractiveAuthorizationDefinition<Resume> {
  return defineInteractiveAuthorization<Resume>({
    displayName: opts.displayName,
    async getToken(o) {
      await assertConnectorGranted(opts.connector);
      return opts.getToken(o);
    },
    startAuthorization: opts.startAuthorization,
    completeAuthorization: opts.completeAuthorization,
    evict: opts.evict,
  });
}
