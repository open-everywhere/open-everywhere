(() => {
  if (window.__oeCapture) return;
  const { createCutRule, rms } = window.OeCutRule;
  const Speakers = window.OeSpeakers;
  const LEVEL_MS = 50;
  const KEEP_SAMPLES_MS = Speakers.CHECK_WINDOW_MS + 60_000;

  const ctx = new AudioContext();
  const bus = ctx.createGain();
  const mix = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  bus.connect(mix);
  bus.connect(analyser);
  const level = new Float32Array(analyser.fftSize);
  const rule = createCutRule();
  const state = { seq: 0, current: null, tracks: 0, samples: [], lastSampleAt: -Infinity, chunks: [], handedOff: Promise.resolve(), platform: "", botName: "" };
  window.__oeCapture = state;

  function attach(track) {
    if (track.kind !== "audio" || state.seen?.has(track.id)) return;
    (state.seen ??= new Set()).add(track.id);
    state.tracks++;
    const stream = new MediaStream([track]);
    const el = document.createElement("audio");
    el.srcObject = stream;
    el.muted = true;
    el.autoplay = true;
    el.style.display = "none";
    document.documentElement.appendChild(el);
    el.play().catch(() => {});
    ctx.createMediaStreamSource(stream).connect(bus);
  }

  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    pc.addEventListener("track", (ev) => attach(ev.track));
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;

  function startChunk(now) {
    const rec = new MediaRecorder(mix.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
    const chunk = { seq: state.seq++, rec, parts: [], startAt: now, endAt: undefined, names: new Set(), sent: undefined };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunk.parts.push(e.data);
    };
    rec.start();
    rule.start(now);
    state.current = chunk;
    state.chunks.push(chunk);
    return chunk;
  }

  const ENCODE_TIMEOUT_MS = 30_000;

  function stopChunk(chunk, now) {
    chunk.endAt = now;
    const speakers = Speakers.chunkSpans(state.samples, chunk.startAt, chunk.endAt);
    const encoded = new Promise((resolve) => {
      setTimeout(() => resolve(undefined), ENCODE_TIMEOUT_MS);
      chunk.rec.onstop = async () => {
        try {
          const blob = new Blob(chunk.parts, { type: "audio/webm" });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          resolve(btoa(bin));
        } catch {
          resolve(undefined);
        }
      };
    });
    const prior = state.handedOff;
    let handOff;
    chunk.handedOff = state.handedOff = new Promise((resolve) => {
      handOff = resolve;
    });
    chunk.sent = (async () => {
      try {
        const base64 = await encoded;
        await prior;
        if (base64 !== undefined) {
          const delivery = window.oeChunk(chunk.seq, base64, { speakers, attendees: [...chunk.names] });
          handOff();
          await delivery;
        }
      } finally {
        handOff();
        state.chunks = state.chunks.filter((c) => c !== chunk);
      }
    })().catch(() => {});
    chunk.rec.stop();
    return chunk.handedOff;
  }

  function handover(now) {
    const prev = state.current;
    startChunk(now);
    if (prev && prev.rec.state !== "inactive") void stopChunk(prev, now);
  }

  function sampleSpeakers(now) {
    const { present, speaking } = Speakers.readPage(document, state.platform, state.botName);
    state.samples.push({ t: now, speaking, quietMs: rule.quietFor(now) });
    for (const name of present) state.current?.names.add(name);
    const keepFrom = now - KEEP_SAMPLES_MS;
    if (state.samples.length > 0 && state.samples[0].t < keepFrom) state.samples = state.samples.filter((s) => s.t >= keepFrom);
  }

  function tick() {
    const now = performance.now();
    analyser.getFloatTimeDomainData(level);
    const cut = rule.sample(now, rms(level));
    if (now - state.lastSampleAt >= Speakers.SAMPLE_MS) {
      state.lastSampleAt = now;
      try {
        sampleSpeakers(now);
      } catch {
      }
    }
    if (cut !== undefined) handover(now);
  }

  window.__oeStartCapture = (opts) => {
    state.platform = opts?.platform ?? "";
    state.botName = opts?.botName ?? "";
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    startChunk(performance.now());
    state.timer = setInterval(tick, LEVEL_MS);
  };
  window.__oeStopCapture = async () => {
    clearInterval(state.timer);
    const last = state.current;
    if (last && last.rec.state !== "inactive") void stopChunk(last, performance.now());
    await Promise.all(state.chunks.map((c) => c.handedOff).filter((p) => p !== undefined));
    return state.seq;
  };
})();
