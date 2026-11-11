import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "../../test/pdf-text";
import { formatCents } from "./money";
import { pdfFilename, pdfResponse, renderInvoicePdf, sanitizeWinAnsi, type PdfDocument } from "./pdf";

async function canEncode() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cache = new Map<number, boolean>();
  return (codePoint: number) => {
    if (codePoint >= 32 && codePoint <= 126) return true;
    const hit = cache.get(codePoint);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      font.encodeText(String.fromCodePoint(codePoint));
      ok = true;
    } catch {
      ok = false;
    }
    cache.set(codePoint, ok);
    return ok;
  };
}

function document(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    number: "INV-0007",
    status: "sent",
    overdue: false,
    from: { name: "Northwind Studio", address: "1 Harbor St", email: "billing@northwind.example" },
    billTo: { name: "Acme", address: "2 Client Rd", email: "" },
    issueDate: "2026-04-01",
    dueDate: "2026-04-15",
    memo: "",
    voidReason: "",
    lines: [{ kind: "hours", description: "Design", quantityX100: 100, unitPriceCents: 10_000, amountCents: 100 }],
    subtotalCents: 5_000,
    taxBp: 825,
    taxCents: 250,
    totalCents: 5_250,
    paidCents: 0,
    balanceCents: 5_250,
    ...overrides,
  };
}

describe("pdf filename and headers", () => {
  it("names the file after the generated invoice number, never user text", () => {
    expect(pdfFilename("INV-0007")).toBe("INV-0007.pdf");
    expect(pdfFilename("INV-10000")).toBe("INV-10000.pdf");
    expect(pdfFilename(null)).toBe("draft.pdf");
    expect(pdfFilename("INV-0007.pdf")).toBe("draft.pdf");
    expect(pdfFilename('INV-0007"; filename="evil.pdf')).toBe("draft.pdf");
    expect(pdfFilename("Acme <script>.pdf")).toBe("draft.pdf");
    expect(pdfFilename("INV-0007\r\nX-Evil: 1")).toBe("draft.pdf");
  });

  it("sets attachment, nosniff and private no-store, and refuses a poisoned filename", () => {
    const res = pdfResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "INV-0007.pdf", {
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV-0007.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");

    const poisoned = pdfResponse(new Uint8Array(), 'INV-0001"; evil.pdf');
    expect(poisoned.headers.get("content-disposition")).toBe('attachment; filename="draft.pdf"');
  });
});

describe("WinAnsi sanitization", () => {
  it("keeps markup as text, keeps Latin-1, and replaces emoji and CJK with question marks", async () => {
    const can = await canEncode();
    expect(sanitizeWinAnsi("Fee <script>alert(1)</script> 😀", can)).toBe("Fee <script>alert(1)</script> ?");
    expect(sanitizeWinAnsi("Café €", can)).toBe("Café €");
    expect(sanitizeWinAnsi("你好", can)).toBe("??");
  });
});

describe("renderInvoicePdf", () => {
  it("draws the script tag as text, substitutes the emoji, and prints the stored totals", async () => {
    const doc = document({
      lines: [
        {
          kind: "fixed",
          description: "Fee <script>alert(1)</script> 😀 done",
          quantityX100: 100,
          unitPriceCents: 10_000,
          amountCents: 100,
        },
      ],
      memo: "Alpha\nBeta",
      subtotalCents: 5_000,
      taxCents: 250,
      totalCents: 5_250,
      balanceCents: 5_250,
    });
    const { bytes, pageCount } = await renderInvoicePdf(doc);
    expect(pageCount).toBeLessThanOrEqual(3);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(Buffer.from(bytes).includes(Buffer.from("😀", "utf8"))).toBe(false);
    const text = extractPdfText(bytes);
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("?");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).not.toContain("Alpha?Beta");
    // The line is $1.00. These three figures are the stored totals, not a sum of the lines.
    expect(text).toContain(formatCents(5_000));
    expect(text).toContain(formatCents(250));
    expect(text).toContain(formatCents(5_250));
    expect(text).toContain("INV-0007");
    expect(text).not.toContain("😀");
  });

  it("fits 50 lines of 300-character descriptions, plus a full memo and address, in 3 pages", async () => {
    const long = "W".repeat(300);
    const doc = document({
      from: { name: "N".repeat(120), address: "A".repeat(300), email: "owner@example.com" },
      billTo: { name: "C".repeat(120), address: "B".repeat(300), email: "" },
      memo: "M".repeat(1000),
      lines: Array.from({ length: 50 }, (_, i) => ({
        kind: i % 3 === 0 ? "hours" : i % 3 === 1 ? "fixed" : "expense",
        description: `<script> ${long}`,
        quantityX100: 9_999_999,
        unitPriceCents: 10_000_000,
        amountCents: 100,
      })),
      subtotalCents: 5_000,
      taxCents: 0,
      totalCents: 5_000,
      balanceCents: 5_000,
    });
    const started = Date.now();
    const { bytes, pageCount } = await renderInvoicePdf(doc);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(pageCount).toBeLessThanOrEqual(3);
    const text = extractPdfText(bytes);
    expect(text).toContain("<script>");
    expect(text).toContain(formatCents(5_000));
    expect(Buffer.from(bytes).includes("<html")).toBe(false);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeLessThanOrEqual(3);
  });
});
