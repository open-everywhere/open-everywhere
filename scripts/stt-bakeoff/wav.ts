export interface Pcm {
  readonly rate: number;
  readonly samples: Int16Array;
}

export function parseWav(buf: Uint8Array): Pcm {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number): string => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number; format: number } | undefined;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const len = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = { format: view.getUint16(off + 8, true), channels: view.getUint16(off + 10, true), rate: view.getUint32(off + 12, true), bits: view.getUint16(off + 22, true) };
    } else if (id === "data") {
      if (fmt === undefined) throw new Error("WAV data chunk before its fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`only 16-bit PCM WAV is supported (format ${fmt.format}, ${fmt.bits} bits)`);
      const frames = Math.floor(Math.min(len, buf.byteLength - off - 8) / (2 * fmt.channels));
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += view.getInt16(off + 8 + (i * fmt.channels + c) * 2, true);
        out[i] = Math.round(sum / fmt.channels);
      }
      return { rate: fmt.rate, samples: out };
    }
    off += 8 + len + (len % 2);
  }
  throw new Error("WAV file has no data chunk");
}

export function encodeWav(pcm: Pcm): Uint8Array {
  const dataLen = pcm.samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, pcm.rate, true);
  v.setUint32(28, pcm.rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.samples.length; i++) v.setInt16(44 + i * 2, pcm.samples[i]!, true);
  return out;
}

export function slicePcm(pcm: Pcm, startSecond: number, endSecond: number): Pcm {
  const a = Math.max(0, Math.round(startSecond * pcm.rate));
  const b = Math.min(pcm.samples.length, Math.round(endSecond * pcm.rate));
  return { rate: pcm.rate, samples: pcm.samples.slice(a, Math.max(a, b)) };
}

export function durationSeconds(pcm: Pcm): number {
  return pcm.samples.length / pcm.rate;
}
