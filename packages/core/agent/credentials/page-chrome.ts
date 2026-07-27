export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const PAGE_STYLE =
  "font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff";

export const BUTTON_STYLE =
  "margin-top:.5rem;padding:.6rem 1.2rem;font:inherit;font-weight:600;color:#fff;background:#1a56db;border:0;border-radius:.4rem;cursor:pointer";

export const CODE_BLOCK_STYLE = "background:#f5f5f5;padding:.75rem;border-radius:.4rem;overflow-x:auto";

export function securePageResponse(status: number, title: string, inner: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${inner}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
