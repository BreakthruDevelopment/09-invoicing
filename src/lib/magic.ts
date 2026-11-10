/** Content types `matchesMagic` can verify. Add a case here to accept another type. */
export type MagicType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * True when the bytes really are the type the client claimed. Never trust a Content-Type header or a file
 * extension; call this on the uploaded bytes before storing or parsing them.
 */
export function matchesMagic(type: MagicType, bytes: Uint8Array): boolean {
  switch (type) {
    case "application/pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      // RIFF <size> WEBP
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}
