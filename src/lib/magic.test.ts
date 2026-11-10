import { describe, expect, it } from "vitest";
import { matchesMagic, type MagicType } from "@/lib/magic";

const bytes = (...v: number[]) => Uint8Array.from(v);
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

const samples: Record<MagicType, Uint8Array> = {
  "application/pdf": ascii("%PDF-1.7\n"),
  "image/jpeg": bytes(0xff, 0xd8, 0xff, 0xe0, 0x00),
  "image/png": bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0),
  "image/webp": Uint8Array.from([...ascii("RIFF"), 1, 0, 0, 0, ...ascii("WEBPVP8 ")]),
};

describe("matchesMagic", () => {
  it.each(Object.keys(samples) as MagicType[])("accepts real %s bytes", (type) => {
    expect(matchesMagic(type, samples[type])).toBe(true);
  });

  it("refuses every type claimed for another type's bytes", () => {
    for (const claimed of Object.keys(samples) as MagicType[]) {
      for (const actual of Object.keys(samples) as MagicType[]) {
        if (claimed !== actual) expect(matchesMagic(claimed, samples[actual]), `${claimed} vs ${actual}`).toBe(false);
      }
    }
  });

  it("refuses empty, truncated, HTML and RIFF-but-not-WebP bytes", () => {
    expect(matchesMagic("image/png", new Uint8Array())).toBe(false);
    expect(matchesMagic("image/jpeg", bytes(0xff, 0xd8))).toBe(false);
    expect(matchesMagic("application/pdf", ascii("%PDF"))).toBe(false);
    expect(matchesMagic("application/pdf", ascii("<html>%PDF-"))).toBe(false);
    expect(matchesMagic("image/webp", Uint8Array.from([...ascii("RIFF"), 1, 0, 0, 0, ...ascii("WAVEfmt ")]))).toBe(false);
  });

  it("refuses an unknown type", () => {
    expect(matchesMagic("image/gif" as MagicType, ascii("GIF89a"))).toBe(false);
  });
});
