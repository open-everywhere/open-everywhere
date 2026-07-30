import { inflateRawSync } from "node:zlib";

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const MAX_EOCD_SCAN = 0xffff + 22;

export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22) throw new ZipReadError(`not a zip archive: ${buf.length} byte(s) is shorter than the smallest possible one`);

  let eocd = -1;
  const from = Math.max(0, buf.length - MAX_EOCD_SCAN);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError("not a zip archive: no end-of-central-directory record found");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipReadError("zip64 archive — this reader is deliberately zip32-only; refusing rather than reading the wrong offsets");
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipReadError(`truncated zip: the central directory claims to end at ${cdOffset + cdSize} but the archive is ${buf.length} byte(s)`);
  }

  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipReadError(`malformed zip: expected a central-directory header for entry ${n + 1}/${entryCount} at offset ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipReadError(`zip entry "${name}" declares ${uncompressedSize} uncompressed byte(s), over the ${MAX_ENTRY_BYTES}-byte cap`);
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new ZipReadError(`malformed zip: entry "${name}" has no local file header at offset ${localOffset}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new ZipReadError(`truncated zip: entry "${name}" claims data through offset ${dataEnd} but the archive is ${buf.length} byte(s)`);
    }
    const raw = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        throw new ZipReadError(`zip entry "${name}" could not be inflated: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new ZipReadError(`zip entry "${name}" uses compression method ${method}; only STORE (0) and DEFLATE (8) are supported`);
    }
    if (data.length !== uncompressedSize) {
      throw new ZipReadError(`zip entry "${name}" inflated to ${data.length} byte(s) but the index declares ${uncompressedSize}`);
    }
    out.set(name, data);
  }
  return out;
}

export function readZipTextEntry(buf: Buffer, basename: string): string {
  const entries = readZipEntries(buf);
  const hits = [...entries.keys()].filter((k) => k.split("/").pop() === basename);
  if (hits.length === 0) {
    throw new ZipReadError(`the archive has no entry named "${basename}" (it contains: ${[...entries.keys()].join(", ") || "nothing"})`);
  }
  if (hits.length > 1) {
    throw new ZipReadError(`the archive has ${hits.length} entries named "${basename}" (${hits.join(", ")}) — refusing to guess which is the real one`);
  }
  return entries.get(hits[0])!.toString("utf8");
}
