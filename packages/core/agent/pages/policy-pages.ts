import { escapeHtml } from "../credentials/page-chrome.js";
import { getSettings, type AgentSettings } from "../settings/settings.js";

export const PRIVACY_PAGE_PATH = "/privacy";
export const TERMS_PAGE_PATH = "/terms";

export type PolicyPageKind = "privacy" | "terms";

const PAGE: Readonly<Record<PolicyPageKind, { readonly title: string; readonly setting: string; readonly noun: string }>> = {
  privacy: { title: "Privacy policy", setting: "policyPages.privacy", noun: "privacy policy" },
  terms: { title: "Terms of use", setting: "policyPages.terms", noun: "terms of use" },
};

const PAGE_STYLE =
  "font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff";

export function policyPageResponse(kind: PolicyPageKind, settings: AgentSettings = getSettings()): Response {
  const { title, setting, noun } = PAGE[kind];
  const text = settings.policyPages[kind];
  const inner =
    text.trim().length > 0
      ? `<main style="white-space:pre-wrap">${escapeHtml(text)}</main>`
      : `<main><p>The operator of this deployment has not published a ${noun} yet.</p>` +
        `<p>Operators: declare the text as <code>${escapeHtml(setting)}</code> in ` +
        `<code>agent/settings/settings.ts</code> and deploy. It is tracked config — a pull request, not a dashboard toggle.</p></main>`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.5rem">${escapeHtml(title)}</h1>${inner}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
