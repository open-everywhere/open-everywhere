export const TEACH_MAX_MS = 10 * 60_000;
export const TEACH_MAX_STEPS = 200;
const MAX_LABEL = 80;

export const SECRET_NAME = /pass(word|wd|code)?|otp|2fa|mfa|one.?time|verif\w*.?code|security.?code|auth\w*.?code|cvv|cvc|csc|card.?num|\bpin\b|secret|token/i;
export const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "submit", "button", "reset", "file", "image", "hidden"]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

export function nameTarget(f) {
  const str = (v) => (typeof v === "string" ? v : "");
  const tag = str(f.tag).toLowerCase();
  const type = str(f.type).toLowerCase();
  const roleAttr = str(f.roleAttr).toLowerCase();
  const editable =
    f.editable === true || tag === "textarea" || (tag === "input" && !NON_TEXT_INPUT_TYPES.has(type)) || EDITABLE_ROLES.has(roleAttr);
  const role = editable
    ? "textbox"
    : roleAttr ||
      (tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" : tag === "select" ? "select" : tag === "input" ? type : tag);
  const pick = editable
    ? [f.ariaLabel, f.labelText, f.placeholder, f.title, f.name]
    : [f.ariaLabel, f.labelText, f.innerText, f.placeholder, f.title, f.alt, f.name, type === "submit" || type === "button" ? f.value : ""];
  const name = label(pick.map(str).find((v) => v.trim().length > 0) ?? "");
  const ac = str(f.autocomplete).toLowerCase().split(/\s+/);
  const hint = `${str(f.name)} ${str(f.id)} ${str(f.ariaLabel)} ${str(f.placeholder)}`;
  const secret = type === "password" || ac.some((a) => SECRET_AUTOCOMPLETE.includes(a)) || (editable && SECRET_NAME.test(hint));
  return secret ? { role, name, secret: true } : { role, name };
}

export function pageAddress(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

function label(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
}

export function createRecorder(now = Date.now) {
  let rec;

  function recording() {
    if (rec === undefined) return false;
    if (now() > rec.until) {
      rec.capped = true;
      return false;
    }
    return true;
  }

  function add(step) {
    if (!recording()) return;
    if (rec.steps.length >= TEACH_MAX_STEPS) {
      rec.capped = true;
      return;
    }
    rec.steps.push(step);
  }

  return {
    recording,

    start(maxMs, url) {
      const ms = typeof maxMs === "number" && maxMs > 0 ? Math.min(maxMs, TEACH_MAX_MS) : TEACH_MAX_MS;
      const at = now();
      rec = { startedAt: at, until: at + ms, steps: [], capped: false, lastAddress: pageAddress(url) };
      if (rec.lastAddress !== undefined) add({ kind: "go", url: rec.lastAddress });
      return { recording: true, until: rec.until };
    },

    noteArrival(url) {
      if (!recording()) return;
      const address = pageAddress(url);
      if (address === undefined || address === rec.lastAddress) return;
      rec.lastAddress = address;
      add({ kind: "arrive", url: address });
    },

    input(body, target) {
      if (!recording()) return;
      const kind = body?.kind;
      if ((kind === "click" || kind === "dblclick") && target) {
        add({ kind: "click", role: label(target.role), name: label(target.name) });
      } else if (kind === "text" && target) {
        const role = label(target.role);
        const name = label(target.name);
        const last = rec.steps[rec.steps.length - 1];
        if (!(last && last.kind === "type" && last.role === role && last.name === name)) add({ kind: "type", role, name, ...(target.secret === true ? { secret: true } : {}) });
      } else if (kind === "key" && typeof body.key === "string") {
        add({ kind: "key", key: body.key });
      } else if (kind === "go") {
        const address = pageAddress(body.url);
        if (address !== undefined) {
          rec.lastAddress = address;
          add({ kind: "go", url: address });
        }
      } else if (kind === "back") {
        add({ kind: "back" });
      }
    },

    stop(url) {
      if (rec === undefined) return { recording: false, none: true, steps: [], capped: false, seconds: 0 };
      this.noteArrival(url);
      const end = Math.min(now(), rec.until);
      const out = { recording: false, steps: rec.steps, capped: rec.capped || now() > rec.until, seconds: Math.round((end - rec.startedAt) / 1000) };
      rec = undefined;
      return out;
    },
  };
}
