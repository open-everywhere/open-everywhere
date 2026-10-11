export const THIRD_PARTY_URL = "https://example.com/";

export const THIRD_PARTY_RECORDED_PAGE =
  '<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content="width=device-width,initial-scale=1">' +
  "<title>Example Domain</title><style>html{color-scheme:light dark;background:light-dark(#eee,#222)}body{font:16px/1.6 system-ui,sans-serif;max-width:26em;margin:auto;padding:25vh 2em 2em;text-align:center}</style>" +
  "</head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p>" +
  "<script src=/s.js></script></body></html>";

export const THIRD_PARTY_STEP =
  `(5) THEN, as a separate step, use browser_navigate to open ${THIRD_PARTY_URL} , then browser_snapshot to see the page, ` +
  'then browser_get with { property: "title" } to read the PAGE TITLE. Use browser_snapshot and browser_get for this step — ' +
  "the ban above applies only to the localhost screenshot in steps 1-4. ";

export const THIRD_PARTY_REPLY_ASK = "the page title browser_get read from example.com";

export const THIRD_PARTY_JUDGE_CLAUSE = "the page title it read from example.com";

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = m?.[1]?.trim() ?? "";
  return title === "" ? null : title;
}
