(function (g) {
  const RULE = Object.freeze({ minMs: 45_000, maxMs: 75_000, silenceMs: 500, silenceRms: 0.01 });

  function rms(buf) {
    if (buf === undefined || buf.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function createCutRule(rule) {
    const r = rule ?? RULE;
    let startAt = 0;
    let quietSince;
    return {
      start(now) {
        startAt = now;
      },
      sample(now, level) {
        if (level < r.silenceRms) quietSince ??= now;
        else quietSince = undefined;
        const age = now - startAt;
        if (age >= r.maxMs) return "max";
        if (age >= r.minMs && quietSince !== undefined && now - quietSince >= r.silenceMs) return "pause";
        return undefined;
      },
      quietFor(now) {
        return quietSince === undefined ? 0 : now - quietSince;
      },
    };
  }

  g.OeCutRule = Object.freeze({ RULE, rms, createCutRule });
})(globalThis);
