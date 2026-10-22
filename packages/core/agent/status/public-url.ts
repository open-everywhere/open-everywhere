import { pageBaseUrl, publicBaseUrlSource, type PublicBaseUrlSource } from "../credentials/page-token.js";
import { oeOauthCallbackUrl, OE_OAUTH_CALLBACK_PATH } from "../connections/oe-oauth-callback.js";
import { roomTrustOf, type SurfaceBinding } from "../identity/binding.js";

const PUBLIC_URL_SETTING = "OE_PUBLIC_BASE_URL";

export type PublicUrlFacts =
  | { readonly kind: "resolved"; readonly baseUrl: string; readonly oauthCallbackUrl: string; readonly source: PublicBaseUrlSource }
  | { readonly kind: "none" };

export function publicUrlFacts(env: NodeJS.ProcessEnv = process.env): PublicUrlFacts {
  const baseUrl = pageBaseUrl(env);
  const oauthCallbackUrl = oeOauthCallbackUrl(env);
  const source = publicBaseUrlSource(env);
  if (baseUrl === undefined || oauthCallbackUrl === undefined || source === undefined) return { kind: "none" };
  return { kind: "resolved", baseUrl, oauthCallbackUrl, source };
}

export function publicUrlDisclosed(binding: SurfaceBinding): boolean {
  return binding.trust === "internal" && roomTrustOf(binding) === "internal";
}

const ONE_CALLBACK =
  "Every service that signs in with OAuth, Notion included, signs in through your own sign-in flow and uses this one callback URL. " +
  "There is no separate callback per service.";

const PREVIEW_HOST_NOTE = `This address is this one deployment's own address, and it changes with each deployment. For an address that stays, an operator sets ${PUBLIC_URL_SETTING}.`;

export function renderSeatPublicUrlSection(facts: PublicUrlFacts, disclosed: boolean, opts: { readonly multiSurface?: boolean } = {}): string {
  const lines: string[] = ["### Your own address"];
  if (opts.multiSurface === true) {
    lines.push(
      "This window serves several conversations, so do not give your own web address or OAuth callback URL from here. " +
        "If someone asks for it, say you give it in a direct message.",
    );
    return lines.join("\n");
  }
  if (!disclosed) {
    lines.push(
      "This conversation may include people from outside the organisation, so do not give your own web address or OAuth callback URL here. " +
        "If someone asks for it, say you give it in a direct message or an internal channel.",
    );
    return lines.join("\n");
  }
  if (facts.kind === "none") {
    lines.push(
      `This deployment has no public web address set, so you cannot give your own address or your OAuth callback URL. Say so plainly, and say that an operator sets ${PUBLIC_URL_SETTING} to fix it. ` +
        `The callback path is \`${OE_OAUTH_CALLBACK_PATH}\`. Never write a placeholder host.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Your web address: ${facts.baseUrl}`,
    `Your OAuth callback URL (the redirect URI): ${facts.oauthCallbackUrl}`,
    `When someone asks for your URL, your callback URL or the redirect URI for a service, give the full value above. ${ONE_CALLBACK}`,
  );
  if (facts.source === "VERCEL_URL") lines.push(PREVIEW_HOST_NOTE);
  return lines.join("\n");
}

export interface PublicUrlAnswer {
  readonly baseUrl?: string;
  readonly oauthCallbackUrl?: string;
  readonly note: string;
  readonly forOperator?: string;
}

export function publicUrlAnswer(facts: PublicUrlFacts, disclosed: boolean): PublicUrlAnswer {
  if (!disclosed) {
    return { note: "This conversation may include people from outside the organisation, so I give my own address only in a direct message or an internal channel." };
  }
  if (facts.kind === "none") {
    return {
      note: "This deployment has no public web address set, so it has no OAuth callback URL yet. An operator sets the address.",
      forOperator: `Set ${PUBLIC_URL_SETTING} to the deployment's public https address.`,
    };
  }
  return {
    baseUrl: facts.baseUrl,
    oauthCallbackUrl: facts.oauthCallbackUrl,
    note: facts.source === "VERCEL_URL" ? `${ONE_CALLBACK} This address is this one deployment's own address, and it changes with each deployment.` : ONE_CALLBACK,
    ...(facts.source === "VERCEL_URL" ? { forOperator: `Set ${PUBLIC_URL_SETTING} for an address that stays the same across deployments.` } : {}),
  };
}
