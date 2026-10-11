(function (g) {
  const SAMPLE_MS = 250;

  const READERS = Object.freeze({
    meet: Object.freeze({
      tiles: ["[data-participant-id]"],
      names: ["[data-self-name]", "span.notranslate"],
      speaking: [".Oaajhc", ".HX2H7", ".wEsLMd", ".OgVli"],
    }),
    teams: Object.freeze({
      tiles: ['[data-cid="calling-participant-stream"]', '[data-tid*="video-tile"]'],
      names: ['[data-tid*="display-name"]', '[data-tid*="participant-name"]'],
      speaking: ['[data-tid="voice-level-stream-outline"].vdi-frame-occlusion', '[data-tid="voice-level-stream-outline"][data-is-speaking="true"]'],
    }),
  });

  function cleanName(v) {
    if (typeof v !== "string") return undefined;
    const s = v
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
      .replace(/[<>[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length === 0) return undefined;
    return s.length > 64 ? s.slice(0, 64) : s;
  }

  function firstMatch(root, selectors) {
    for (const sel of selectors) {
      let el = null;
      try {
        el = root.querySelector(sel);
      } catch {
        el = null;
      }
      if (el) return el;
    }
    return null;
  }

  function readPage(doc, platform, botName) {
    const reader = READERS[platform];
    const present = [];
    const speaking = [];
    if (reader === undefined || doc === undefined || doc === null) return { present, speaking };
    const self = cleanName(botName);
    const tiles = new Set();
    for (const sel of reader.tiles) {
      let found = [];
      try {
        found = doc.querySelectorAll(sel);
      } catch {
        found = [];
      }
      for (const t of found) tiles.add(t);
    }
    for (const tile of tiles) {
      const nameEl = firstMatch(tile, reader.names);
      const name = cleanName(nameEl ? nameEl.textContent : undefined);
      if (name === undefined || name === self || /^you$/i.test(name)) continue;
      if (!present.includes(name)) present.push(name);
      if (firstMatch(tile, reader.speaking) && !speaking.includes(name)) speaking.push(name);
    }
    return { present, speaking };
  }

  function counts(samples) {
    let deep = 0;
    let deepLit = 0;
    let loud = 0;
    let loudLit = 0;
    for (const s of samples) {
      const lit = s.speaking.length > 0;
      if (s.quietMs >= 1_000) {
        deep++;
        if (lit) deepLit++;
      } else if (s.quietMs === 0) {
        loud++;
        if (lit) loudLit++;
      }
    }
    return { deep, deepLit, loud, loudLit };
  }

  function indicatorAgrees(samples) {
    const { deep, deepLit, loud, loudLit } = counts(samples);
    if (deep < 4 || loud < 8) return false;
    return deepLit <= deep / 4 && loudLit >= loud / 2;
  }

  function chunkContradicts(samples) {
    const { deep, deepLit, loud, loudLit } = counts(samples);
    return (deep >= 2 && deepLit > deep / 4) || (loud >= 8 && loudLit < loud / 2);
  }

  const CHECK_WINDOW_MS = 180_000;

  function chunkSpans(samples, startAt, endAt) {
    if (!indicatorAgrees(samples.filter((s) => s.t >= endAt - CHECK_WINDOW_MS && s.t < endAt))) return [];
    const inside = samples.filter((s) => s.t >= startAt && s.t < endAt);
    if (chunkContradicts(inside)) return [];
    const spans = [];
    const open = new Map();
    for (const s of inside) {
      const from = Math.round(s.t - startAt);
      const to = Math.round(Math.min(s.t + SAMPLE_MS, endAt) - startAt);
      for (const name of s.speaking) {
        const span = open.get(name);
        if (span !== undefined && span.endMs >= from) span.endMs = to;
        else {
          const next = { name, startMs: from, endMs: to };
          open.set(name, next);
          spans.push(next);
        }
      }
    }
    return spans.filter((s) => s.endMs > s.startMs);
  }

  g.OeSpeakers = Object.freeze({ SAMPLE_MS, CHECK_WINDOW_MS, READERS, cleanName, readPage, indicatorAgrees, chunkSpans });
})(globalThis);
