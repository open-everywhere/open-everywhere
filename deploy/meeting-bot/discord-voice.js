export const RULE = Object.freeze({ minMs: 45_000, maxMs: 75_000, gapMs: 300 });
export const TURN_CUT_BUDGET = 1_500;
export const OUT_RATE = 16_000;

export function isLeakedDaveFrame(frame) {
  return frame !== undefined && frame !== null && frame.length >= 2 && frame[frame.length - 2] === 0xfa && frame[frame.length - 1] === 0xfa;
}

export function createVoiceDirectory() {
  const present = new Set();
  let heard = false;
  return {
    onPacket(packet) {
      const d = packet?.d;
      if (d === undefined || d === null) return;
      if (packet.op === 5 && typeof d.user_id === "string" && Number.isInteger(d.ssrc)) {
        present.add(d.user_id);
        heard = true;
      } else if (packet.op === 11 && Array.isArray(d.user_ids)) {
        for (const id of d.user_ids) if (typeof id === "string") present.add(id);
        heard = true;
      } else if (packet.op === 13 && typeof d.user_id === "string") {
        present.delete(d.user_id);
        heard = true;
      }
    },
    others(botId) {
      if (!heard) return undefined;
      return [...present].filter((id) => id !== botId).length;
    },
  };
}

export function toMono16k(pcm) {
  const frames = Math.floor(pcm.length / 2);
  const out = new Int16Array(Math.floor(frames / 3));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const f = (i * 3 + k) * 2;
      sum += pcm[f] + pcm[f + 1];
    }
    out[i] = Math.round(sum / 6);
  }
  return out;
}

export function wavFile(samples, rate = OUT_RATE) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

export function createVoiceCapture({ subscribe, decode, onChunk, now = Date.now, rule = RULE, turnCutBudget = TURN_CUT_BUDGET }) {
  const t0 = now();
  const members = new Map();
  let emitted = 0;
  const stats = { dropped: 0, subscriptions: 0, undecodable: 0 };
  const msOf = (samples) => (samples / OUT_RATE) * 1000;

  function member(userId) {
    let m = members.get(userId);
    if (m === undefined) {
      m = { live: false, chunk: undefined, newUtterance: true };
      members.set(userId, m);
    }
    return m;
  }

  function flush(userId, reason) {
    const m = members.get(userId);
    if (m?.chunk === undefined || m.chunk.samples === 0) return;
    const { parts, atMs, samples } = m.chunk;
    m.chunk = undefined;
    const all = new Int16Array(samples);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    emitted++;
    onChunk({ userId, atMs, samples: all, reason });
  }

  return {
    stats,
    speakingStart(userId) {
      if (emitted < turnCutBudget) {
        for (const [other, m] of members) {
          if (other !== userId && m.chunk !== undefined) flush(other, "turn");
        }
      }
      const m = member(userId);
      if (m.live) return;
      m.live = true;
      m.newUtterance = true;
      stats.subscriptions++;
      subscribe(userId);
    },
    frame(userId, opus) {
      if (isLeakedDaveFrame(opus)) {
        stats.dropped++;
        return;
      }
      let pcm;
      try {
        pcm = toMono16k(decode(opus));
      } catch {
        stats.undecodable++;
        return;
      }
      const m = member(userId);
      if (m.chunk === undefined) {
        m.chunk = { parts: [], samples: 0, atMs: now() - t0 };
        m.newUtterance = false;
      } else if (m.newUtterance) {
        const gap = new Int16Array(Math.round((rule.gapMs / 1000) * OUT_RATE));
        m.chunk.parts.push(gap);
        m.chunk.samples += gap.length;
        m.newUtterance = false;
      }
      m.chunk.parts.push(pcm);
      m.chunk.samples += pcm.length;
      if (msOf(m.chunk.samples) >= rule.maxMs) flush(userId, "max");
    },
    streamEnd(userId) {
      const m = member(userId);
      m.live = false;
      m.newUtterance = true;
      if (m.chunk !== undefined && msOf(m.chunk.samples) >= rule.minMs) flush(userId, "pause");
    },
    flushAll() {
      const open = [...members.entries()].filter(([, m]) => m.chunk !== undefined).sort((a, b) => a[1].chunk.atMs - b[1].chunk.atMs);
      for (const [userId] of open) flush(userId, "end");
    },
  };
}
