import {
  defineInteractiveAuthorization,
  type ConnectionAuthProvider,
  type ConnectionAuthResolver,
  type InteractiveAuthorizationDefinition,
  type JsonValue,
  type TokenResult,
} from "eve/connections";
import type { SessionContext } from "eve/context";
import { assertConnectorGranted, boundConnectorCredential } from "../access/connector-scope.js";
import { getSecret } from "../access/credentials.js";

const connectAuthById = new Map<string, Promise<ConnectionAuthProvider>>();
function connectAuthFor(connector: string, vercelConnector: string): Promise<ConnectionAuthProvider> {
  let p = connectAuthById.get(vercelConnector);
  if (!p) {
    p = (async () => {
      try {
        const spec = "@vercel/connect" + "/eve";
        const mod = (await import(spec)) as { connect(o: { connector: string }): ConnectionAuthProvider };
        return mod.connect({ connector: vercelConnector });
      } catch {
        throw new Error(
          `connection "${connector}": service OAuth needs @vercel/connect (LIVE-ONLY). ` +
            `Install it + link a Vercel project, or use a fixed-key credential.`,
        );
      }
    })();
    connectAuthById.set(vercelConnector, p);
  }
  return p;
}

export function appStaticToken(opts: {
  readonly connector: string;
  readonly secretRef: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken() {
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      return { token: await getSecret(opts.secretRef) };
    },
  });
}

export function appConnectToken(opts: {
  readonly connector: string;
  readonly vercelConnector: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const base = await connectAuthFor(opts.connector, opts.vercelConnector);
      return (base as { getToken(o: unknown): unknown }).getToken(o) as Promise<TokenResult>;
    },
  });
}

export function appProviderToken(opts: {
  readonly connector: string;
  readonly fallbackSecretRef?: string;
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> => ({
    principalType: "app",
    async getToken(o) {
      await assertConnectorGranted(opts.connector, ctx.session.auth);
      const cred = await boundConnectorCredential(opts.connector, ctx.session.auth);
      if (!cred) {
        if (opts.fallbackSecretRef) return { token: await getSecret(opts.fallbackSecretRef) };
        throw new Error(
          `connection "${opts.connector}": no provider credential bound for this surface and no ` +
            `fallback secret — grant it via a provider (bundle.providers) or a raw connection secretRef.`,
        );
      }
      if (cred.type === "api-key") {
        if (!cred.secretRef) throw new Error(`connection "${opts.connector}": api-key credential has no secretRef`);
        return { token: await getSecret(cred.secretRef) };
      }
      if (cred.type === "service-oauth") {
        if (!cred.vercelConnector)
          throw new Error(`connection "${opts.connector}": service-oauth credential has no vercelConnector`);
        const base = await connectAuthFor(opts.connector, cred.vercelConnector);
        return (base as { getToken(o: unknown): unknown }).getToken(o) as Promise<TokenResult>;
      }
      throw new Error(
        `connection "${opts.connector}": credential type "${cred.type}" is not valid on an app connection ` +
          `(user-principal credentials resolve in the DM universe).`,
      );
    },
  });
}

export function userInteractiveOAuth<Resume extends JsonValue = JsonValue>(opts: {
  readonly connector: string;
  readonly getToken: InteractiveAuthorizationDefinition<Resume>["getToken"];
  readonly startAuthorization: InteractiveAuthorizationDefinition<Resume>["startAuthorization"];
  readonly completeAuthorization: InteractiveAuthorizationDefinition<Resume>["completeAuthorization"];
  readonly displayName?: string;
  readonly evict?: InteractiveAuthorizationDefinition<Resume>["evict"];
}): ConnectionAuthResolver {
  return async (ctx: SessionContext): Promise<ConnectionAuthProvider> =>
    defineInteractiveAuthorization<Resume>({
      displayName: opts.displayName,
      async getToken(o) {
        await assertConnectorGranted(opts.connector, ctx.session.auth);
        return opts.getToken(o);
      },
      startAuthorization: opts.startAuthorization,
      completeAuthorization: opts.completeAuthorization,
      evict: opts.evict,
    });
}
