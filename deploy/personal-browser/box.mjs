import http from "node:http";
import net from "node:net";
import { bareHost, checkedAddress as fenceAddress, hostAllowed as fenceAllowed, parseAllow, parseUpstream, upstreamTarget, upstreamTunnel } from "./fence.mjs";
import { createRecorder, nameTarget, SECRET_AUTOCOMPLETE, SECRET_NAME } from "./teach.mjs";
import { BOX_CAPABILITIES, paymentSubmitRefusal } from "./never.mjs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const KEY = process.env.OE_PB_KEY ?? "";
delete process.env.OE_PB_KEY;
if (KEY.length < 32) {
  console.error("[oe-personal-browser] OE_PB_KEY is missing or short — refusing to start");
  process.exit(2);
}
const PORT = Number(process.env.OE_PB_PORT ?? "8080");
const PROFILE = process.env.OE_PB_PROFILE_DIR || path.join(os.homedir(), ".oe-personal-browser");
const ALLOW = parseAllow(process.env.OE_PB_ALLOW ?? "[]");
const IDLE_MS = Math.max(5, Number(process.env.OE_PB_IDLE_MINUTES ?? "15")) * 60_000 + 5 * 60_000;
const MAX_BODY = 64 * 1024;
const PROXY_PORT = Number(process.env.OE_PB_PROXY_PORT ?? "8091");
const SKEW_MS = 2 * 60_000;
const UPSTREAM = parseUpstream(process.env.OE_BOX_EGRESS_PROXY);
if (process.env.OE_BOX_EGRESS_PROXY && UPSTREAM === undefined) {
  console.error("[oe-personal-browser] OE_BOX_EGRESS_PROXY is not an http://host:port origin — refusing to start");
  process.exit(2);
}
const EGRESS_CA = process.env.OE_BOX_EGRESS_CA ?? "";
delete process.env.OE_BOX_EGRESS_CA;
const VIEWPORT = { width: 1280, height: 800 };

const hostAllowed = (host) => fenceAllowed(host, ALLOW);
const checkedAddress = (host) => (UPSTREAM !== undefined ? Promise.resolve(upstreamTarget(host, ALLOW)) : fenceAddress(host, ALLOW));

function trustEgressCa() {
  if (EGRESS_CA.trim() === "") return;
  const db = path.join(os.homedir(), ".pki", "nssdb");
  const file = path.join(os.tmpdir(), "oe-egress-ca.crt");
  try {
    mkdirSync(db, { recursive: true });
    writeFileSync(file, EGRESS_CA);
    try {
      execFileSync("certutil", ["-d", `sql:${db}`, "-N", "--empty-password"], { stdio: "ignore" });
    } catch {
    }
    execFileSync("certutil", ["-d", `sql:${db}`, "-A", "-t", "C,,", "-n", "oe-egress", "-i", file], { stdio: "ignore" });
  } catch (err) {
    console.error(`[oe-personal-browser] could not trust the egress proxy's CA (${String(err)}); a site the proxy decrypts will fail`);
  }
}

function urlAllowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") return false;
  return hostAllowed(u.hostname);
}

const seen = new Map();

function verify(req, body) {
  const header = String(req.headers["x-oe-box-auth"] ?? "");
  const dot = header.indexOf(".");
  if (dot <= 0) return false;
  const ts = Number(header.slice(0, dot));
  const sig = header.slice(dot + 1);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return false;
  const digest = createHash("sha256").update(body).digest("hex");
  const want = createHmac("sha256", KEY).update(`${ts}\n${req.method}\n${req.url}\n${digest}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(sig)) return false;
  seen.set(sig, now + 2 * SKEW_MS);
  return true;
}

let context;
let page;
let lock = { holder: "agent", until: 0 };

function personHolds() {
  return lock.holder === "person" && (lock.until === 0 || lock.until > Date.now());
}
let lastUsed = Date.now();

function startFenceProxy() {
  const proxy = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const address = target.protocol === "http:" ? await checkedAddress(target.hostname) : undefined;
    if (address === undefined) {
      res.writeHead(403, { "content-type": "text/plain" }).end("host not allowed");
      return;
    }
    const upstream = http.request(
      UPSTREAM !== undefined
        ? { host: UPSTREAM.host, port: UPSTREAM.port, method: req.method, path: target.href, headers: req.headers }
        : { host: address, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on("connect", async (req, client, head) => {
    let upstream;
    client.on("error", () => upstream?.destroy());
    const m = /^(.+):(\d+)$/.exec(req.url ?? "");
    const host = m ? bareHost(m[1]) : "";
    const port = m ? Number(m[2]) : 0;
    const address = m && port > 0 && port < 65536 ? await checkedAddress(host) : undefined;
    if (address === undefined) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (UPSTREAM !== undefined) {
      const tunnel = await upstreamTunnel(UPSTREAM, address, port);
      if (tunnel === undefined) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      upstream = tunnel.socket;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (tunnel.head.length > 0) client.write(tunnel.head);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
      return;
    }
    upstream = net.connect(port, address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  return new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
}

async function launch() {
  trustEgressCa();
  await startFenceProxy();
  mkdirSync(PROFILE, { recursive: true });
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(path.join(PROFILE, f), { force: true });
  const env = { ...process.env };
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    proxy: { server: `http://127.0.0.1:${PROXY_PORT}`, bypass: "<-loopback>" },
    viewport: VIEWPORT,
    acceptDownloads: false,
    serviceWorkers: "block",
    env,
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-features=WebRtcHideLocalIpsWithMdns", "--disable-quic"],
  });
  await context.route("**/*", async (route) => {
    if (urlAllowed(route.request().url())) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (ws) => {
    if (urlAllowed(ws.url())) ws.connectToServer();
    else ws.close({ code: 1008, reason: "host not allowed" });
  });
  page = context.pages()[0] ?? (await context.newPage());
  context.on("page", (p) => {
    page = p;
  });
}

async function state() {
  let title = "";
  try {
    title = await page.title();
  } catch {
  }
  return { url: page.url(), title: title.slice(0, 200) };
}

function snapshotInPage({ max, re, acs }) {
  const SECRET_NAME_RE = new RegExp(re, "i");
  const SECRET_AC = new Set(acs);
  const sel =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true]';
  for (const e of document.querySelectorAll("[data-oe-ref]")) e.removeAttribute("data-oe-ref");
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === "hidden" || st.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    const ref = `e${++n}`;
    el.setAttribute("data-oe-ref", ref);
    const role =
      el.getAttribute("role") ||
      (tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" : tag === "select" ? "select" : tag === "textarea" ? "textbox" : tag === "input" ? (["checkbox", "radio", "submit", "button", "reset", "file"].includes(type) ? type : "textbox") : tag);
    const label = (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || (type === "submit" || type === "button" ? el.value : "") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
    const secret = type === "password" || ac.some((a) => SECRET_AC.has(a)) || ((role === "textbox") && SECRET_NAME_RE.test(hint));
    const item = { ref, role, name: label };
    if (secret) item.secret = true;
    if (role === "checkbox" || role === "radio") item.checked = Boolean(el.checked || el.getAttribute("aria-checked") === "true");
    out.push(item);
  }
  const text = document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 8000) : "";
  return { elements: out, text };
}

function locator(ref) {
  if (typeof ref !== "string" || !/^e\d{1,4}$/.test(ref)) throw new BoxError("bad-ref", "that element reference is not one from the last look at the page");
  return page.locator(`[data-oe-ref="${ref}"]`).first();
}

async function isSecretField(loc) {
  return await loc.evaluate(
    (el, [re, acs]) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      const hint = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
      return type === "password" || ac.some((a) => acs.includes(a)) || new RegExp(re, "i").test(hint);
    },
    [SECRET_NAME.source, [...SECRET_AUTOCOMPLETE]],
  );
}

function paymentFactsInPage({ ref }) {
  const start = typeof ref === "string" ? document.querySelector(`[data-oe-ref="${ref}"]`) : document.activeElement;
  let control = null;
  let form = null;
  if (start && start !== document.body) {
    const el = (start.closest && start.closest("button,input,select,textarea,a[href],summary,[role=button],[role=link]")) || start;
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const submitControl = (tag === "button" && type !== "button" && type !== "reset") || (tag === "input" && (type === "submit" || type === "image"));
    const raw = el.getAttribute("aria-label") || el.innerText || (tag === "input" && (type === "submit" || type === "button") ? el.value : "") || el.getAttribute("title") || "";
    control = { submitControl, label: String(raw).replace(/\s+/g, " ").trim().slice(0, 200) };
    form = el.form || (el.closest ? el.closest("form") : null);
  }
  const root = form || document;
  const hintOf = (f) => `${f.getAttribute("name") || ""} ${f.id || ""} ${f.getAttribute("aria-label") || ""} ${f.getAttribute("placeholder") || ""} ${(f.labels && f.labels[0] && f.labels[0].innerText) || ""}`;
  const fields = [...root.querySelectorAll("input,select,textarea")].slice(0, 300).map((f) => ({ autocomplete: f.getAttribute("autocomplete") || "", hint: hintOf(f) }));
  const hostOf = (f) => {
    try {
      return new URL(f.getAttribute("src") || "", location.href).hostname;
    } catch {
      return "";
    }
  };
  const frames = [...root.querySelectorAll("iframe[src]")].slice(0, 50).map(hostOf);
  const pageFrames = [...document.querySelectorAll("iframe[src]")].slice(0, 50).map(hostOf);
  return { control, scope: form ? "form" : "page", fields, frames, pageFrames };
}

async function refusePaymentSubmit(body) {
  const sendsMaybe = body.op === "click" || (body.op === "type" && body.submit === true) || (body.op === "key" && (body.key === "Enter" || body.key === "Space"));
  if (!sendsMaybe) return;
  const facts = await page.evaluate(paymentFactsInPage, { ref: body.op === "key" ? undefined : body.ref }).catch(() => null);
  if (facts === null) throw new BoxError("payment-check-failed", "I could not check whether that step submits a payment form, so I did not act — the person can do it after they take the controls");
  const refusal = paymentSubmitRefusal({ ...facts, op: body.op, key: body.key, submit: body.submit === true });
  if (refusal !== undefined) throw new BoxError("payment-submit", refusal);
}

class BoxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function settle() {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
}

const KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"]);

const WRITE_OPS = new Set(["click", "type", "select", "key"]);

const recorder = createRecorder();

function targetFactsInPage({ x, y }) {
  const sel =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const start = typeof x === "number" ? document.elementFromPoint(x, y) : document.activeElement;
  const el = start && start.closest ? start.closest(sel) : null;
  if (!el) return null;
  const editable = el.isContentEditable === true;
  return {
    tag: el.tagName,
    type: el.getAttribute("type") || "",
    roleAttr: el.getAttribute("role") || "",
    editable,
    ariaLabel: el.getAttribute("aria-label") || "",
    labelText: (el.labels && el.labels[0] && el.labels[0].innerText) || "",
    innerText: editable ? "" : (el.innerText || "").slice(0, 200),
    placeholder: el.getAttribute("placeholder") || "",
    title: el.getAttribute("title") || "",
    alt: el.getAttribute("alt") || "",
    name: el.getAttribute("name") || "",
    value: (el.getAttribute("type") || "").toLowerCase() === "submit" || (el.getAttribute("type") || "").toLowerCase() === "button" ? el.value || "" : "",
    autocomplete: el.getAttribute("autocomplete") || "",
    id: el.id || "",
  };
}

async function describeTarget(point) {
  if (!recorder.recording()) return null;
  const facts = await page.evaluate(targetFactsInPage, point).catch(() => null);
  return facts ? nameTarget(facts) : null;
}

async function noteArrival() {
  if (!recorder.recording()) return;
  const s = await state();
  recorder.noteArrival(s.url);
}

async function command(body, byPerson = false) {
  const op = body.op;
  if (!byPerson && personHolds()) throw new BoxError("person-holds", "the person has the controls of this browser, so the agent's action was refused");
  if (WRITE_OPS.has(op)) {
    let host = "";
    try {
      host = new URL(page.url()).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (typeof body.expectHost !== "string" || body.expectHost !== host) {
      throw new BoxError("page-moved", "the page moved to another site before the action, so I did not act — look again");
    }
    await refusePaymentSubmit(body);
  }
  if (op === "go") {
    if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) throw new BoxError("bad-url", "give a full http(s) URL");
    if (!urlAllowed(body.url)) throw new BoxError("host-not-allowed", "this deployment's egress declaration does not admit that host for your browser");
    await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await state();
  }
  if (op === "look") {
    const snap = await page.evaluate(snapshotInPage, { max: 150, re: SECRET_NAME.source, acs: [...SECRET_AUTOCOMPLETE] });
    return { ...(await state()), ...snap };
  }
  if (op === "find") {
    if (typeof body.role !== "string" || typeof body.name !== "string") throw new BoxError("bad-find", "give the role and the label to find");
    const snap = await page.evaluate(snapshotInPage, { max: 150, re: SECRET_NAME.source, acs: [...SECRET_AUTOCOMPLETE] });
    const want = body.name.replace(/\s+/g, " ").trim().toLowerCase();
    const same = snap.elements.filter((e) => e.role === body.role);
    const hit = same.find((e) => e.name.toLowerCase() === want) ?? (want.length > 0 ? same.find((e) => e.name.toLowerCase().includes(want)) : undefined);
    return { ...(await state()), found: hit ? hit.ref : null };
  }
  if (op === "click") {
    await locator(body.ref).click({ timeout: 10_000 });
    await settle();
    return await state();
  }
  if (op === "type") {
    const loc = locator(body.ref);
    if (await isSecretField(loc)) throw new BoxError("secret-field", "that is a password, code or card field — the person types it themselves after they take the controls");
    if (typeof body.text !== "string" || body.text.length > 2000) throw new BoxError("bad-text", "text must be a string of at most 2000 characters");
    await loc.fill(body.text, { timeout: 10_000 });
    if (body.submit === true) {
      await loc.press("Enter");
      await settle();
    }
    return await state();
  }
  if (op === "select") {
    if (typeof body.value !== "string") throw new BoxError("bad-value", "give the option to select");
    await locator(body.ref).selectOption({ label: body.value }, { timeout: 10_000 }).catch(async () => await locator(body.ref).selectOption(body.value, { timeout: 10_000 }));
    return await state();
  }
  if (op === "key") {
    if (!KEYS.has(body.key)) throw new BoxError("bad-key", `key must be one of ${[...KEYS].join(", ")}`);
    await page.keyboard.press(body.key === "Space" ? " " : body.key);
    await settle();
    return await state();
  }
  if (op === "scroll") {
    await page.mouse.wheel(0, body.direction === "up" ? -700 : 700);
    return await state();
  }
  if (op === "back") {
    await page.goBack({ timeout: 15_000 }).catch(() => undefined);
    return await state();
  }
  if (op === "sites") {
    const domains = [...new Set((await context.cookies()).map((c) => c.domain.replace(/^\./, "").toLowerCase()))].sort().slice(0, 200);
    return { ...(await state()), sites: domains };
  }
  throw new BoxError("bad-op", "unknown action");
}

let lastFrame = { at: 0, buf: undefined };

async function frame() {
  const now = Date.now();
  if (lastFrame.buf !== undefined && now - lastFrame.at < 250) return lastFrame.buf;
  const buf = await page.screenshot({ type: "jpeg", quality: 55, timeout: 10_000 });
  lastFrame = { at: now, buf };
  return buf;
}

async function input(body) {
  await noteArrival();
  const target = body.kind === "click" || body.kind === "dblclick" ? await describeTarget({ x: Number(body.x), y: Number(body.y) }) : body.kind === "text" ? await describeTarget({}) : null;
  const out = await performInput(body);
  recorder.input(body, target);
  return out;
}

async function performInput(body) {
  const kind = body.kind;
  if (kind === "click" || kind === "dblclick") {
    const x = Number(body.x);
    const y = Number(body.y);
    if (!(x >= 0 && x <= VIEWPORT.width && y >= 0 && y <= VIEWPORT.height)) throw new BoxError("bad-point", "the point is outside the page");
    await page.mouse.click(x, y, { clickCount: kind === "dblclick" ? 2 : 1 });
    return await state();
  }
  if (kind === "text") {
    if (typeof body.text !== "string" || body.text.length > 2000) throw new BoxError("bad-text", "text must be at most 2000 characters");
    await page.keyboard.insertText(body.text);
    return await state();
  }
  if (kind === "key") {
    if (!KEYS.has(body.key)) throw new BoxError("bad-key", "that key is not supported");
    await page.keyboard.press(body.key === "Space" ? " " : body.key);
    return await state();
  }
  if (kind === "scroll") {
    const dy = Math.max(-3000, Math.min(3000, Number(body.dy) || 0));
    await page.mouse.wheel(0, dy);
    return await state();
  }
  if (kind === "go") return await command({ op: "go", url: body.url }, true);
  if (kind === "back") return await command({ op: "back" }, true);
  if (kind === "reload") {
    await page.reload({ timeout: 30_000 }).catch(() => undefined);
    return await state();
  }
  throw new BoxError("bad-input", "unknown input");
}

let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await context?.close();
  } catch {
  }
  process.exit(code);
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    if (!verify(req, body)) return send(res, 401, { ok: false });
    lastUsed = Date.now();
    let parsed = {};
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(res, 400, { ok: false, code: "bad-json" });
      }
    }
    const url = (req.url ?? "").split("?")[0];
    try {
      if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true, capabilities: BOX_CAPABILITIES, ...(await state()) });
      if (req.method === "GET" && url === "/frame") return send(res, 200, await frame(), "image/jpeg");
      if (req.method === "POST" && url === "/cmd") return send(res, 200, { ok: true, ...(await command(parsed)) });
      if (req.method === "POST" && url === "/input") return send(res, 200, { ok: true, ...(await input(parsed)) });
      if (req.method === "POST" && url === "/teach") {
        const s = await state();
        if (parsed.action === "start") return send(res, 200, { ok: true, ...recorder.start(parsed.maxMs, s.url) });
        if (parsed.action === "stop") return send(res, 200, { ok: true, ...recorder.stop(s.url) });
        return send(res, 400, { ok: false, code: "bad-teach" });
      }
      if (req.method === "POST" && url === "/lock") {
        if (parsed.holder !== "agent" && parsed.holder !== "person") return send(res, 400, { ok: false, code: "bad-lock" });
        lock = { holder: parsed.holder, until: typeof parsed.until === "number" ? parsed.until : 0 };
        return send(res, 200, { ok: true, holder: lock.holder });
      }
      if (req.method === "POST" && url === "/shutdown") {
        send(res, 200, { ok: true });
        return void shutdown(0);
      }
      return send(res, 404, { ok: false });
    } catch (err) {
      const code = err instanceof BoxError ? err.code : "page-error";
      const message = err instanceof BoxError ? err.message : "the page did not respond to that action";
      return send(res, 200, { ok: false, code, message });
    }
  });
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

setInterval(() => {
  if (Date.now() - lastUsed > IDLE_MS) void shutdown(0);
}, 60_000).unref();

await launch();
server.listen(PORT, "0.0.0.0", () => console.log(`[oe-personal-browser] listening on ${PORT}`));
