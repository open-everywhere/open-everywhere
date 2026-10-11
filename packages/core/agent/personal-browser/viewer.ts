import { randomBytes } from "node:crypto";
import { escapeHtml, securePageResponse, BUTTON_STYLE } from "../credentials/page-chrome.js";
import { mintPageToken, pageBaseUrl, pageTokenSigningKey, verifyPageToken } from "../credentials/page-token.js";
import { appendAudit } from "../audit/audit.js";
import { postSurfaceTextStrict } from "../channels/surface-message-ops.js";
import { callBox } from "./box-client.js";
import { handBack, mintViewId, personHolds, takeOver, type LifecycleDeps } from "./lifecycle.js";
import { getPersonalBrowserState, updatePersonalBrowser, type PersonalBrowserState } from "./store.js";

export const BROWSER_VIEW_PATH = "/browser/v1/view";
export const BROWSER_LIVE_PATH = "/browser/v1/live";
export const BROWSER_SESSION_COOKIE = "oe_pb";
export const WATCH_LINK_TTL_MS = 10 * 60_000;
export const WATCH_SESSION_TTL_MS = 60 * 60_000;
export const BROWSER_CSRF_HEADER = "x-oe-pb";
const TOUCH_EVERY_MS = 60_000;

export interface ViewerDeps extends LifecycleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly post?: (platform: string, target: { channelId: string; text: string }) => Promise<string>;
}

export async function issueWatchLink(state: Pick<PersonalBrowserState, "org" | "person">, deps: ViewerDeps = {}): Promise<{ readonly url: string; readonly expiresAt: number } | undefined> {
  const env = deps.env ?? process.env;
  const secret = pageTokenSigningKey(env);
  const base = pageBaseUrl(env);
  if (secret === undefined || base === undefined) return undefined;
  const now = (deps.now ?? Date.now)();
  const id = mintViewId();
  const exp = now + WATCH_LINK_TTL_MS;
  const ok = await updatePersonalBrowser(state.org, state.person, (cur) => (cur === undefined ? { next: undefined, result: false } : { next: { ...cur, links: { ...cur.links, [id]: exp } }, result: true }), now);
  if (!ok) return undefined;
  const token = mintPageToken({ v: 1, aud: "browser-view", org: state.org, id, rb: state.person, exp }, secret);
  return { url: `${base}${BROWSER_VIEW_PATH}?t=${encodeURIComponent(token)}`, expiresAt: exp };
}

const NOT_FOUND_TITLE = "This link has expired";

function notFound(): Response {
  return securePageResponse(404, NOT_FOUND_TITLE, `<p>This browser link is no longer valid. Ask me in our direct message for a new one.</p>`);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export async function handleViewGet(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const secret = pageTokenSigningKey(deps.env ?? process.env);
  if (secret === undefined) return notFound();
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const now = (deps.now ?? Date.now)();
  const claims = verifyPageToken(token, secret, "browser-view", now);
  if (claims === null) return notFound();
  const found = await getPersonalBrowserState(claims.org, claims.rb);
  if (found === undefined || !((found.state.links[claims.id] ?? 0) > now)) return notFound();
  return securePageResponse(
    200,
    "Your browser",
    `<p>This opens your own browser, with the sites you are signed in to. You can watch what I do and take the controls.</p>` +
      `<p>The link works once. Don't forward it: whoever opens it first can watch and control your browser for an hour.</p>` +
      `<form method="post" action="${BROWSER_VIEW_PATH}"><input type="hidden" name="t" value="${escapeHtml(token)}">` +
      `<button type="submit" style="${BUTTON_STYLE}">Open my browser</button></form>`,
  );
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/browser/v1/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export async function handleViewPost(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const secret = pageTokenSigningKey(deps.env ?? process.env);
  if (secret === undefined) return notFound();
  let token = "";
  try {
    token = new URLSearchParams(await req.text()).get("t") ?? "";
  } catch {
    return notFound();
  }
  const now = (deps.now ?? Date.now)();
  const claims = verifyPageToken(token, secret, "browser-view", now);
  if (claims === null) return notFound();
  const sessionId = mintViewId();
  const sessionExp = now + WATCH_SESSION_TTL_MS;
  const state = await updatePersonalBrowser(claims.org, claims.rb, (cur) => {
    if (cur === undefined || !((cur.links[claims.id] ?? 0) > now)) return { next: undefined, result: undefined };
    const { [claims.id]: _used, ...links } = cur.links;
    const next: PersonalBrowserState = { ...cur, links, sessions: { ...cur.sessions, [sessionId]: sessionExp } };
    return { next, result: next };
  }, now);
  if (state === undefined) return notFound();
  await appendAudit({
    org: state.partition.org,
    platform: state.partition.platform,
    workspace: state.partition.workspace,
    surface: state.partition.surface,
    principalId: state.principalId,
    action: "browser.personal.view_opened",
    detail: { session: sessionId.slice(0, 8), until: new Date(sessionExp).toISOString() },
  });
  const sessionToken = mintPageToken({ v: 1, aud: "browser-session", org: claims.org, id: sessionId, rb: claims.rb, exp: sessionExp }, secret);
  const secure = new URL(req.url).protocol === "https:";
  const res = securePageResponse(200, "Opening your browser", `<p><a href="${BROWSER_LIVE_PATH}">Continue to your browser</a></p>`);
  const headers = new Headers(res.headers);
  headers.set("set-cookie", sessionCookie(sessionToken, secure, Math.floor(WATCH_SESSION_TTL_MS / 1000)));
  headers.set("refresh", `0; url=${BROWSER_LIVE_PATH}`);
  return new Response(res.body, { status: 200, headers });
}

interface Session {
  readonly state: PersonalBrowserState;
  readonly sessionId: string;
  readonly now: number;
}

async function sessionOf(req: Request, deps: ViewerDeps): Promise<Session | undefined> {
  const secret = pageTokenSigningKey(deps.env ?? process.env);
  if (secret === undefined) return undefined;
  const token = cookieValue(req, BROWSER_SESSION_COOKIE);
  if (token === undefined) return undefined;
  const now = (deps.now ?? Date.now)();
  const claims = verifyPageToken(token, secret, "browser-session", now);
  if (claims === null) return undefined;
  const found = await getPersonalBrowserState(claims.org, claims.rb);
  if (found === undefined || !((found.state.sessions[claims.id] ?? 0) > now)) return undefined;
  return { state: found.state, sessionId: claims.id, now };
}

function csrfOk(req: Request): boolean {
  return req.headers.get(BROWSER_CSRF_HEADER) === "1";
}

async function touch(s: Session): Promise<void> {
  if (s.state.box === undefined) return;
  if (s.now - (s.state.lastUsedAt ?? 0) < TOUCH_EVERY_MS) return;
  await updatePersonalBrowser(s.state.org, s.state.person, (cur) => (cur?.box === undefined ? { next: undefined, result: undefined } : { next: { ...cur, lastUsedAt: s.now }, result: undefined }), s.now);
}

export async function handleLiveGet(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const s = await sessionOf(req, deps);
  if (s === undefined) return notFound();
  const nonce = randomBytes(16).toString("base64");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Your browser</title>` +
    `<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;background:#f4f4f5;color:#111}header{display:flex;gap:.5rem;align-items:center;padding:.5rem .75rem;background:#fff;border-bottom:1px solid #ddd;flex-wrap:wrap}` +
    `#who{font-weight:600}#addr{flex:1;min-width:12rem;padding:.35rem .5rem;font:inherit}button{padding:.4rem .9rem;font:inherit;font-weight:600;border:0;border-radius:.35rem;cursor:pointer;background:#1a56db;color:#fff}` +
    `button[disabled]{opacity:.45;cursor:default}main{padding:.75rem;text-align:center}#f{max-width:100%;border:1px solid #ccc;background:#fff;outline:none}#f.live{border:3px solid #16a34a}#note{color:#555;margin:.5rem}</style></head><body>` +
    `<header><span id="who">Watching</span><input id="addr" readonly aria-label="Address"><button id="go" disabled>Go</button><button id="back" disabled>Back</button>` +
    `<button id="take">Take the controls</button><button id="give" disabled>Hand back to the agent</button></header>` +
    `<main><img id="f" alt="Your browser" tabindex="0" width="1280" height="800"><p id="note">You are watching. Take the controls to sign in, type a code or solve a check. Your keystrokes go to your browser only: I don't see or store them.</p></main>` +
    `<script nonce="${nonce}">${LIVE_SCRIPT}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; img-src 'self' blob:; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    },
  });
}

export async function handleLiveFrame(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const s = await sessionOf(req, deps);
  if (s === undefined) return jsonResponse(404, { ok: false });
  if (s.state.box === undefined) return jsonResponse(409, { ok: false, closed: true });
  try {
    const res = await callBox(s.state.box, "GET", "/frame", undefined, 15_000);
    if (res.bytes === undefined) return jsonResponse(502, { ok: false });
    await touch(s);
    return new Response(res.bytes, { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return jsonResponse(502, { ok: false });
  }
}

export async function handleLiveState(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const s = await sessionOf(req, deps);
  if (s === undefined) return jsonResponse(404, { ok: false });
  const holder = personHolds(s.state, s.now) ? "person" : "agent";
  if (s.state.box === undefined) return jsonResponse(200, { ok: true, running: false, holder });
  let url = "";
  let title = "";
  try {
    const res = await callBox(s.state.box, "GET", "/health", undefined, 10_000);
    url = typeof res.json?.["url"] === "string" ? (res.json["url"] as string) : "";
    title = typeof res.json?.["title"] === "string" ? (res.json["title"] as string) : "";
  } catch {
  }
  return jsonResponse(200, { ok: true, running: true, holder, ...(s.state.lock.until !== undefined && holder === "person" ? { until: s.state.lock.until } : {}), url, title });
}

export async function handleLiveControl(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const s = await sessionOf(req, deps);
  if (s === undefined || !csrfOk(req)) return jsonResponse(404, { ok: false });
  let action: unknown;
  try {
    action = ((await req.json()) as { action?: unknown }).action;
  } catch {
    return jsonResponse(400, { ok: false });
  }
  if (action === "takeover") {
    if (s.state.box === undefined) return jsonResponse(409, { ok: false, closed: true });
    const r = await takeOver(s.state.org, s.state.person, "page", deps);
    return jsonResponse(r === undefined ? 409 : 200, { ok: r !== undefined, ...(r !== undefined ? { until: r.until } : {}) });
  }
  if (action === "handback") {
    const changed = await handBack(s.state.org, s.state.person, "page", deps);
    if (changed) {
      try {
        await (deps.post ?? postSurfaceTextStrict)(s.state.platform, {
          channelId: s.state.dm.channelId,
          text: "You handed your browser back to me. Tell me here to carry on, and I'll pick up from the page you left.",
        });
      } catch {
      }
    }
    return jsonResponse(200, { ok: true, changed });
  }
  return jsonResponse(400, { ok: false });
}

const INPUT_KINDS = new Set(["click", "dblclick", "text", "key", "scroll", "go", "back", "reload"]);

export async function handleLiveInput(req: Request, deps: ViewerDeps = {}): Promise<Response> {
  const s = await sessionOf(req, deps);
  if (s === undefined || !csrfOk(req)) return jsonResponse(404, { ok: false });
  if (s.state.box === undefined) return jsonResponse(409, { ok: false, closed: true });
  if (!personHolds(s.state, s.now)) return jsonResponse(409, { ok: false, holder: "agent" });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { ok: false });
  }
  if (typeof body["kind"] !== "string" || !INPUT_KINDS.has(body["kind"])) return jsonResponse(400, { ok: false });
  const event: Record<string, unknown> = { kind: body["kind"] };
  for (const k of ["x", "y", "dy"]) if (typeof body[k] === "number") event[k] = body[k];
  for (const k of ["text", "key", "url"]) if (typeof body[k] === "string") event[k] = (body[k] as string).slice(0, 2000);
  try {
    const res = await callBox(s.state.box, "POST", "/input", event, 30_000);
    await touch(s);
    return jsonResponse(200, { ok: res.json?.["ok"] === true, ...(typeof res.json?.["message"] === "string" ? { message: res.json["message"] } : {}) });
  } catch {
    return jsonResponse(502, { ok: false });
  }
}

const LIVE_SCRIPT = `
(function(){
var H={'x-oe-pb':'1','content-type':'application/json'};
var img=document.getElementById('f'),who=document.getElementById('who'),addr=document.getElementById('addr'),note=document.getElementById('note');
var take=document.getElementById('take'),give=document.getElementById('give'),go=document.getElementById('go'),back=document.getElementById('back');
var holder='agent',ended=false,buf='',flushT=null;
function post(p,b){return fetch(p,{method:'POST',headers:H,body:JSON.stringify(b),credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return {ok:false};})});}
function send(ev){if(holder!=='person')return;post('${BROWSER_LIVE_PATH}/input',ev).then(function(j){if(j&&j.message)note.textContent=j.message;});}
function flush(){if(buf){send({kind:'text',text:buf});buf='';}flushT=null;}
function render(){var mine=holder==='person';who.textContent=mine?'You have the controls':'Watching the agent';take.disabled=mine;give.disabled=!mine;go.disabled=!mine;back.disabled=!mine;addr.readOnly=!mine;img.className=mine?'live':'';}
function state(){fetch('${BROWSER_LIVE_PATH}/state',{headers:H,cache:'no-store',credentials:'same-origin'}).then(function(r){if(r.status!==200){end('This watch session has ended. Ask me in our direct message for a new link.');return null;}return r.json();}).then(function(j){if(!j)return;if(!j.running){note.textContent='Your browser is closed. Ask me in our direct message to open it.';}holder=j.holder;if(document.activeElement!==addr)addr.value=j.url||'';render();}).catch(function(){});}
function frame(){if(ended)return;fetch('${BROWSER_LIVE_PATH}/frame?ts='+Date.now(),{headers:H,cache:'no-store',credentials:'same-origin'}).then(function(r){if(r.status===404){end('This watch session has ended. Ask me in our direct message for a new link.');return null;}return r.ok?r.blob():null;}).then(function(b){if(!b)return;var u=URL.createObjectURL(b);img.onload=function(){URL.revokeObjectURL(u);};img.src=u;}).catch(function(){}).then(function(){setTimeout(frame,holder==='person'?400:900);});}
function end(t){ended=true;note.textContent=t;take.disabled=true;give.disabled=true;}
img.addEventListener('click',function(e){if(holder!=='person')return;var r=img.getBoundingClientRect();send({kind:'click',x:Math.round((e.clientX-r.left)*1280/r.width),y:Math.round((e.clientY-r.top)*800/r.height)});img.focus();});
img.addEventListener('wheel',function(e){if(holder!=='person')return;e.preventDefault();send({kind:'scroll',dy:Math.round(e.deltaY)});},{passive:false});
img.addEventListener('keydown',function(e){if(holder!=='person')return;var special={Enter:1,Tab:1,Escape:1,Backspace:1,Delete:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,PageUp:1,PageDown:1,Home:1,End:1};
if(special[e.key]){e.preventDefault();flush();send({kind:'key',key:e.key});return;}
if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){e.preventDefault();buf+=e.key;if(!flushT)flushT=setTimeout(flush,150);}});
img.addEventListener('paste',function(e){if(holder!=='person')return;var t=(e.clipboardData||{}).getData?e.clipboardData.getData('text'):'';if(t){e.preventDefault();flush();send({kind:'text',text:t});}});
take.addEventListener('click',function(){post('${BROWSER_LIVE_PATH}/control',{action:'takeover'}).then(function(){state();img.focus();});});
give.addEventListener('click',function(){flush();post('${BROWSER_LIVE_PATH}/control',{action:'handback'}).then(function(){note.textContent='You handed the controls back. I told the agent in your direct message.';state();});});
go.addEventListener('click',function(){var u=addr.value.trim();if(u&&!/^https?:\\/\\//i.test(u))u='https://'+u;if(u)send({kind:'go',url:u});});
back.addEventListener('click',function(){send({kind:'back'});});
addr.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();go.click();}});
state();setInterval(state,2000);frame();
})();
`;
