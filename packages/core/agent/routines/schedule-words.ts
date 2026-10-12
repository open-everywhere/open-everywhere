import { shortUtc } from "../approvals/session-grant.js";
import { plainValue } from "../approvals/plain-text.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

function intIn(field: string, min: number, max: number): number | undefined {
  if (!/^\d{1,2}$/.test(field)) return undefined;
  const n = Number(field);
  return n >= min && n <= max ? n : undefined;
}

export function cronWords(expr: string): string {
  const f = expr.trim().split(/\s+/u);
  if (f.length !== 5) return "on a custom schedule";
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  const everyMin = /^\*\/(\d{1,2})$/u.exec(m);
  if (everyMin && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${Number(everyMin[1])} min`;
  const minute = intIn(m, 0, 59);
  if (minute === undefined || dom !== "*" || mon !== "*") return "on a custom schedule";
  const everyHour = /^\*\/(\d{1,2})$/u.exec(h);
  if (h === "*" && dow === "*") return minute === 0 ? "every hour" : `every hour at :${twoDigits(minute)}`;
  if (everyHour && dow === "*") return `every ${Number(everyHour[1])} hours`;
  const hour = intIn(h, 0, 23);
  if (hour === undefined) return "on a custom schedule";
  const at = `at ${twoDigits(hour)}:${twoDigits(minute)} UTC`;
  if (dow === "*") return `daily ${at}`;
  if (dow === "1-5" || dow === "MON-FRI") return `weekdays ${at}`;
  if (dow === "0,6" || dow === "6,0" || dow === "SAT,SUN") return `weekends ${at}`;
  const day = intIn(dow, 0, 7);
  if (day !== undefined) return `every ${DAYS[day % 7]} ${at}`;
  return "on a custom schedule";
}

export interface TriggerShape {
  readonly kind: string;
  readonly expr?: string;
  readonly everyMinutes?: number;
  readonly at?: string;
  readonly source?: string;
}

export function triggerWords(t: TriggerShape): string {
  switch (t.kind) {
    case "cron":
      return cronWords(t.expr ?? "");
    case "interval":
      return `every ${t.everyMinutes ?? "?"} min`;
    case "watch": {
      const when = t.expr !== undefined ? cronWords(t.expr) : `every ${t.everyMinutes ?? "?"} min`;
      return `${when}, posting only on a change`;
    }
    case "once":
      return t.at !== undefined ? `once on ${shortUtc(t.at)}` : "once";
    case "event":
      return t.source !== undefined ? `when ${t.source} sends an event` : "on an event";
    default:
      return "on its own";
  }
}

export function routineWords(description: string | undefined): string {
  const d = description ?? "";
  const cron = /^cron "([^"]+)"/u.exec(d);
  if (cron) return `the routine that runs ${cronWords(cron[1]!)}`;
  const every = /^every (\d+) min/u.exec(d);
  if (every) return `the routine that runs every ${every[1]} min`;
  const once = /^once at (\S+)/u.exec(d);
  if (once) return `the routine set for ${shortUtc(once[1]!)}`;
  const named = plainValue(d, 50);
  return named === "(unnamed)" ? "the routine" : `the routine “${named}”`;
}

export function toolWords(declarationOrTool: string): string {
  const name = declarationOrTool.replace(/^(?:tool:|connector\.tool:|connector:)/u, "");
  const [connector, ...rest] = name.split("__");
  if (rest.length === 0) return (connector ?? name).replace(/[_.-]+/gu, " ").trim();
  return `${rest.join(" ").replace(/[_.-]+/gu, " ").trim()} on ${connector}`;
}
