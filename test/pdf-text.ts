import { inflateSync } from "node:zlib";

/**
 * Pull the text pdf-lib drew. Standard fonts are written as hex strings of WinAnsi bytes, inside
 * Flate-compressed content streams. ASCII (and Latin-1) round-trips; this is only for tests.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const src = Buffer.from(bytes).toString("latin1");
  let blob = "";
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf("stream", i);
    if (start < 0) break;
    let dataStart = start + "stream".length;
    if (src.charCodeAt(dataStart) === 13) dataStart++;
    if (src.charCodeAt(dataStart) === 10) dataStart++;
    const end = src.indexOf("endstream", dataStart);
    if (end < 0) break;
    let dataEnd = end;
    if (dataEnd > dataStart && src.charCodeAt(dataEnd - 1) === 10) dataEnd--;
    if (dataEnd > dataStart && src.charCodeAt(dataEnd - 1) === 13) dataEnd--;
    const raw = Buffer.from(src.slice(dataStart, dataEnd), "latin1");
    const header = src.slice(Math.max(0, start - 400), start);
    let decoded = raw;
    if (header.includes("/FlateDecode")) {
      try {
        decoded = inflateSync(raw);
      } catch {
        decoded = raw;
      }
    }
    blob += decoded.toString("latin1");
    i = end + "endstream".length;
  }

  let text = "";
  const re = /<([0-9A-Fa-f\s]+)>/g;
  for (const match of blob.matchAll(re)) {
    const hex = match[1].replace(/\s+/g, "");
    if (hex.length < 2 || hex.length % 2 !== 0) continue;
    text += Buffer.from(hex, "hex").toString("latin1");
  }
  return text;
}
