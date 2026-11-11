import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { todayIn } from "@/lib/invoice-common";
import { getInvoice, type InvoiceDetail } from "@/lib/invoices";
import { formatCents } from "@/lib/money";
import { ownedBy } from "@/lib/owned";
import { resolveShareToken } from "@/lib/share";

const { businessProfile, client, invoiceLine } = schema;

/**
 * Invoice PDFs. Drawn with pdf-lib's standard Helvetica (a built-in font, nothing embedded) and never stored:
 * each download is rendered from the invoice row. Amounts are the cents already computed and saved by
 * `money.ts` — this file only prints them with `formatCents`. It does not add lines up again.
 *
 * Helvetica speaks WinAnsi (PDF's Windows-1252). `sanitizeWinAnsi` turns every other character into "?".
 * Tabs and line breaks are whitespace, not missing glyphs: tabs become spaces and line breaks start a new
 * paragraph. Markup such as `<script>` is ordinary text; a PDF content stream is not HTML.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 36;
const MARGIN_TOP = 36;
const CONTENT_BOTTOM = 42;
const LIMIT = PAGE_H - MARGIN_TOP - CONTENT_BOTTOM;
const LEFT = MARGIN_X;
const RIGHT = PAGE_W - MARGIN_X;
const WIDTH = RIGHT - LEFT;

/** Body sizes tried largest-first. A 50-line invoice, including 300-character descriptions, has to fit in 3 pages. */
const BODY_SIZES = [9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5];

const INK = rgb(0.12, 0.14, 0.16);
const MUTED = rgb(0.38, 0.4, 0.44);
const RULE = rgb(0.75, 0.77, 0.8);

const GENERATED_NUMBER = /^INV-\d{4,}$/;

export type PdfParty = { name: string; address: string; email: string };
export type PdfLine = {
  kind: string;
  description: string;
  quantityX100: number;
  unitPriceCents: number;
  /** Stored line amount. Printed as-is; not derived from quantity and price here. */
  amountCents: number;
};

export type PdfDocument = {
  /** Generated `INV-0001`, or null on a draft. Never a name the user typed. */
  number: string | null;
  status: string;
  overdue: boolean;
  from: PdfParty;
  billTo: PdfParty;
  issueDate: string;
  dueDate: string;
  memo: string;
  voidReason: string;
  lines: PdfLine[];
  subtotalCents: number;
  taxBp: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
};

type FontName = "regular" | "bold";
type InkName = "ink" | "muted";
type Piece = { text: string; x: number; size: number; font: FontName; color: InkName; baseline: number };
type Row = { height: number; pieces: Piece[]; rule?: boolean };
type Fonts = { regular: PDFFont; bold: PDFFont };
type CanEncode = (codePoint: number) => boolean;
type Width = (text: string) => number;

/**
 * The download name is the generated invoice number. Anything else (a draft, or a number that isn't one we
 * generated) is the fixed name `draft.pdf`, so a header can never carry user text.
 */
export function pdfFilename(number: string | null | undefined): string {
  return number && GENERATED_NUMBER.test(number) ? `${number}.pdf` : "draft.pdf";
}

/** `attachment` with that filename, `nosniff`, and `private, no-store`. Extra headers (the public route's) are kept. */
export function pdfResponse(bytes: Uint8Array, filename: string, extra?: Record<string, string>): Response {
  const safe = /^(?:INV-\d{4,}|draft)\.pdf$/.test(filename) ? filename : "draft.pdf";
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `attachment; filename="${safe}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  return new Response(Buffer.from(bytes), { status: 200, headers });
}

/**
 * Replace every code point Helvetica cannot encode with "?". ASCII such as `<script>` is unchanged.
 * `canEncode` is the embedded Helvetica font's own check, so this can't drift from what `drawText` accepts.
 */
export function sanitizeWinAnsi(text: string, canEncode: CanEncode): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    out += canEncode(cp) ? ch : "?";
  }
  return out;
}

function encoderFor(font: PDFFont): CanEncode {
  const cache = new Map<number, boolean>();
  return (codePoint) => {
    // Printable ASCII is in WinAnsi. Skipping the try/catch keeps a long invoice cheap.
    if (codePoint >= 32 && codePoint <= 126) return true;
    const cached = cache.get(codePoint);
    if (cached !== undefined) return cached;
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

/** Line breaks become paragraphs. Tabs become spaces. Backspace is not printable, so it becomes "?". */
function paragraphs(text: string): string[] {
  return text
    .replace(/\u0008/g, "?")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029\u0085]/g, "\n")
    .replace(/[\t\v\f\u000b]/g, " ")
    .split("\n")
    .map((p) => p.replace(/ +/g, " ").trim())
    .filter((p) => p.length > 0);
}

function wrapParagraph(width: Width, text: string, maxWidth: number, canEncode: CanEncode): string[] {
  const clean = sanitizeWinAnsi(text, canEncode).replace(/ +/g, " ").trim();
  if (!clean) return [];
  const lines: string[] = [];
  let line = "";
  const push = (next: string) => {
    if (line) lines.push(line);
    line = next;
  };
  for (const word of clean.split(" ")) {
    const chunks = width(word) <= maxWidth ? [word] : breakWord(width, word, maxWidth);
    for (const chunk of chunks) {
      const next = line ? `${line} ${chunk}` : chunk;
      if (line && width(next) > maxWidth) push(chunk);
      else line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function breakWord(width: Width, word: string, maxWidth: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    const next = cur + ch;
    if (cur && width(next) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else cur = next;
  }
  if (cur) parts.push(cur);
  return parts.length > 0 ? parts : [word];
}

function wrap(width: Width, text: string, maxWidth: number, canEncode: CanEncode): string[] {
  return paragraphs(text).flatMap((p) => wrapParagraph(width, p, maxWidth, canEncode));
}

function measurer(font: PDFFont, size: number): Width {
  const chars = new Map<string, number>();
  return (text) => {
    if (text.length <= 48) return font.widthOfTextAtSize(text, size);
    let total = 0;
    for (const ch of text) {
      let w = chars.get(ch);
      if (w === undefined) {
        w = font.widthOfTextAtSize(ch, size);
        chars.set(ch, w);
      }
      total += w;
    }
    return total;
  };
}

function widest(width: Width, values: readonly string[]): number {
  let w = 0;
  for (const v of values) w = Math.max(w, width(v));
  return w;
}

function textRows(width: Width, text: string, x: number, size: number, maxWidth: number, leading: number, font: FontName, color: InkName, canEncode: CanEncode): Row[] {
  return wrap(width, text, maxWidth, canEncode).map((line) => ({
    height: leading,
    pieces: [{ text: line, x, size, font, color, baseline: size }],
  }));
}

function gap(height: number): Row {
  return { height, pieces: [] };
}

function ruleRow(): Row {
  return { height: 7, pieces: [], rule: true };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

function formatTaxRate(taxBp: number): string {
  if (!Number.isSafeInteger(taxBp) || taxBp < 0) return "0.00%";
  return `${Math.trunc(taxBp / 100)}.${String(taxBp % 100).padStart(2, "0")}%`;
}

function formatQuantity(quantityX100: number): string {
  if (!Number.isSafeInteger(quantityX100) || quantityX100 < 0) return "?";
  const whole = Math.trunc(quantityX100 / 100);
  const frac = quantityX100 % 100;
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(frac).padStart(2, "0")}`;
}

function kindLabel(kind: string): string {
  if (kind === "hours") return "Hours";
  if (kind === "fixed") return "Fixed";
  if (kind === "expense") return "Expense";
  return "Item";
}

function statusLabel(doc: PdfDocument): string {
  if (doc.status === "sent" && doc.overdue) return "Overdue";
  if (doc.status === "draft") return "Draft";
  if (doc.status === "sent") return "Sent";
  if (doc.status === "paid") return "Paid";
  if (doc.status === "void") return "Void";
  return "Invoice";
}

function numberLabel(number: string | null): string {
  return number && GENERATED_NUMBER.test(number) ? number : "Draft";
}

type Metrics = { body: number; leading: number; title: number; name: number };

function metricsOf(body: number): Metrics {
  return { body, leading: body + 2, title: body + 6, name: body + 2 };
}

type Columns = { typeX: number; descX: number; descW: number; qtyRight: number; rateRight: number; amountRight: number };

function columnsFor(fonts: Fonts, body: number, doc: PdfDocument): Columns {
  const reg = measurer(fonts.regular, body);
  const pad = 8;
  const typeW = Math.max(reg("Type"), reg("Expense"), reg("Hours"), reg("Fixed"), reg("Item")) + pad;
  const qtyW = widest(reg, ["Qty", ...doc.lines.map((l) => formatQuantity(l.quantityX100))]) + pad;
  const rateW = widest(reg, ["Rate", ...doc.lines.map((l) => formatCents(l.unitPriceCents))]) + pad;
  const amountW = widest(reg, [
    "Amount",
    ...doc.lines.map((l) => formatCents(l.amountCents)),
    formatCents(doc.subtotalCents),
    formatCents(doc.taxCents),
    formatCents(doc.totalCents),
    formatCents(doc.paidCents),
    formatCents(doc.balanceCents),
  ]) + pad;
  const descX = LEFT + typeW;
  const descW = Math.max(48, RIGHT - amountW - rateW - qtyW - descX);
  const qtyRight = descX + descW + qtyW;
  const rateRight = qtyRight + rateW;
  return { typeX: LEFT, descX, descW, qtyRight, rateRight, amountRight: RIGHT };
}

function partyRows(fonts: Fonts, party: PdfParty, x: number, width: number, m: Metrics, canEncode: CanEncode, nameFirst: boolean): Row[] {
  const rows: Row[] = [];
  const nameWidth = measurer(nameFirst ? fonts.bold : fonts.regular, nameFirst ? m.name : m.body);
  const bodyWidth = measurer(fonts.regular, m.body);
  if (party.name) rows.push(...textRows(nameWidth, party.name, x, nameFirst ? m.name : m.body, width, nameFirst ? m.name + 2 : m.leading, nameFirst ? "bold" : "regular", "ink", canEncode));
  if (party.address) rows.push(...textRows(bodyWidth, party.address, x, m.body, width, m.leading, "regular", "ink", canEncode));
  if (party.email) rows.push(...textRows(bodyWidth, party.email, x, m.body, width, m.leading, "regular", "muted", canEncode));
  return rows;
}

function zip(left: Row[], right: Row[]): Row[] {
  const n = Math.max(left.length, right.length);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    rows.push({ height: Math.max(l?.height ?? 0, r?.height ?? 0), pieces: [...(l?.pieces ?? []), ...(r?.pieces ?? [])] });
  }
  return rows;
}

function rightPiece(text: string, right: number, width: Width, size: number, font: FontName, color: InkName): Piece {
  return { text, x: right - width(text), size, font, color, baseline: size };
}

function headerRows(doc: PdfDocument, fonts: Fonts, m: Metrics, canEncode: CanEncode): Row[] {
  const metaX = LEFT + WIDTH * 0.58;
  const metaW = RIGHT - metaX;
  const fromW = metaX - LEFT - 16;
  const reg = measurer(fonts.regular, m.body);
  const boldTitle = measurer(fonts.bold, m.title);
  const from = partyRows(fonts, doc.from, LEFT, fromW, m, canEncode, true);
  const meta: Row[] = [
    { height: m.title + 3, pieces: [{ text: "INVOICE", x: metaX, size: m.title, font: "bold", color: "ink", baseline: m.title }] },
    ...textRows(boldTitle, numberLabel(doc.number), metaX, m.title, metaW, m.title + 2, "bold", "ink", canEncode),
    ...textRows(reg, statusLabel(doc), metaX, m.body, metaW, m.leading, "regular", doc.overdue ? "ink" : "muted", canEncode),
    ...textRows(reg, `Issued ${formatDate(doc.issueDate)}`, metaX, m.body, metaW, m.leading, "regular", "ink", canEncode),
    ...textRows(reg, `Due ${formatDate(doc.dueDate)}`, metaX, m.body, metaW, m.leading, "regular", "ink", canEncode),
  ];
  const rows: Row[] = [...zip(from, meta), gap(8), ruleRow(), gap(6)];
  rows.push(...textRows(reg, "Bill to", LEFT, m.body, WIDTH, m.leading, "regular", "muted", canEncode));
  const bill = partyRows(fonts, doc.billTo, LEFT, WIDTH * 0.6, m, canEncode, true);
  if (bill.length === 0) rows.push(...textRows(reg, "No client yet", LEFT, m.body, WIDTH, m.leading, "regular", "muted", canEncode));
  else rows.push(...bill);
  if (doc.voidReason) {
    rows.push(gap(4));
    rows.push(...textRows(reg, `Voided: ${doc.voidReason}`, LEFT, m.body, WIDTH, m.leading, "regular", "ink", canEncode));
  }
  rows.push(gap(10));
  return rows;
}

function tableHeader(fonts: Fonts, m: Metrics, cols: Columns): Row[] {
  const bold = measurer(fonts.bold, m.body);
  const piece = (text: string, x: number): Piece => ({ text, x, size: m.body, font: "bold", color: "muted", baseline: m.body });
  return [
    {
      height: m.leading,
      pieces: [
        piece("Type", cols.typeX),
        piece("Description", cols.descX),
        rightPiece("Qty", cols.qtyRight, bold, m.body, "bold", "muted"),
        rightPiece("Rate", cols.rateRight, bold, m.body, "bold", "muted"),
        rightPiece("Amount", cols.amountRight, bold, m.body, "bold", "muted"),
      ],
    },
    ruleRow(),
  ];
}

/** Most rendered rows one line's description may take. Longer text is clipped with "..." so a max-size invoice fits 3 pages. */
const MAX_DESCRIPTION_ROWS = 3;

function clipRows(width: Width, rows: string[], maxWidth: number): string[] {
  if (rows.length <= MAX_DESCRIPTION_ROWS) return rows;
  const kept = rows.slice(0, MAX_DESCRIPTION_ROWS);
  let last = kept[MAX_DESCRIPTION_ROWS - 1];
  while (last && width(`${last}...`) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[MAX_DESCRIPTION_ROWS - 1] = `${last}...`;
  return kept;
}

function itemRows(doc: PdfDocument, fonts: Fonts, m: Metrics, cols: Columns, canEncode: CanEncode): Row[] {
  const reg = measurer(fonts.regular, m.body);
  const rows: Row[] = [];
  for (const line of doc.lines) {
    const inColumn = clipRows(reg, wrap(reg, line.description, cols.descW, canEncode), cols.descW);
    const fits = inColumn.length <= 1;
    const descLines = fits ? inColumn : clipRows(reg, wrap(reg, line.description, WIDTH - 12, canEncode), WIDTH - 12);
    const pieces: Piece[] = [
      { text: kindLabel(line.kind), x: cols.typeX, size: m.body, font: "regular", color: "muted", baseline: m.body },
      rightPiece(formatQuantity(line.quantityX100), cols.qtyRight, reg, m.body, "regular", "ink"),
      rightPiece(formatCents(line.unitPriceCents), cols.rateRight, reg, m.body, "regular", "ink"),
      rightPiece(formatCents(line.amountCents), cols.amountRight, reg, m.body, "regular", "ink"),
    ];
    if (fits && descLines[0]) pieces.push({ text: descLines[0], x: cols.descX, size: m.body, font: "regular", color: "ink", baseline: m.body });
    rows.push({ height: m.leading, pieces });
    if (!fits) {
      for (const text of descLines) {
        rows.push({ height: m.leading, pieces: [{ text, x: LEFT + 12, size: m.body, font: "regular", color: "ink", baseline: m.body }] });
      }
    }
    rows.push(gap(2));
  }
  return rows;
}

function summaryRows(doc: PdfDocument, fonts: Fonts, m: Metrics, canEncode: CanEncode): Row[] {
  const reg = measurer(fonts.regular, m.body);
  const bold = measurer(fonts.bold, m.body);
  const entries: { label: string; value: string; font: FontName }[] = [
    { label: "Subtotal", value: formatCents(doc.subtotalCents), font: "regular" },
    { label: `Tax (${formatTaxRate(doc.taxBp)})`, value: formatCents(doc.taxCents), font: "regular" },
    { label: "Total", value: formatCents(doc.totalCents), font: "bold" },
  ];
  if (doc.paidCents > 0) entries.push({ label: "Paid", value: formatCents(doc.paidCents), font: "regular" });
  if (doc.status === "draft" || doc.status === "sent") entries.push({ label: "Amount due", value: formatCents(doc.balanceCents), font: "bold" });
  const valueW = Math.max(...entries.map((e) => (e.font === "bold" ? bold : reg)(e.value)));
  const rows: Row[] = [gap(6), ruleRow()];
  for (const e of entries) {
    const w = e.font === "bold" ? bold : reg;
    const labelRight = RIGHT - valueW - 14;
    rows.push({
      height: m.leading + 1,
      pieces: [
        { text: e.label, x: labelRight - w(e.label), size: m.body, font: e.font, color: "ink", baseline: m.body },
        { text: e.value, x: RIGHT - w(e.value), size: m.body, font: e.font, color: "ink", baseline: m.body },
      ],
    });
  }
  if (doc.memo) {
    rows.push(gap(12));
    rows.push(...textRows(reg, "Notes", LEFT, m.body, WIDTH, m.leading, "regular", "muted", canEncode));
    rows.push(...textRows(reg, doc.memo, LEFT, m.body, WIDTH, m.leading, "regular", "ink", canEncode));
  }
  return rows;
}

function bannerRows(doc: PdfDocument, fonts: Fonts, m: Metrics, canEncode: CanEncode): Row[] {
  const reg = measurer(fonts.regular, m.body);
  return [...textRows(reg, `${numberLabel(doc.number)} (continued)`, LEFT, m.body, WIDTH, m.leading, "regular", "muted", canEncode), gap(4)];
}

type Block = { rows: Row[]; repeat?: Row[] };

function rowHeight(rows: readonly Row[]): number {
  return rows.reduce((s, r) => s + r.height, 0);
}

function pack(blocks: Block[]): Row[][] {
  const pages: Row[][] = [[]];
  let used = 0;
  let repeat: Row[] = [];

  function newPage() {
    pages.push([]);
    used = 0;
    if (repeat.length > 0) {
      pages[pages.length - 1].push(...repeat);
      used += rowHeight(repeat);
    }
  }

  for (const block of blocks) {
    repeat = block.repeat ?? [];
    for (const row of block.rows) {
      if (used > 0 && used + row.height > LIMIT) newPage();
      pages[pages.length - 1].push(row);
      used += row.height;
    }
    repeat = [];
  }
  return pages.filter((p) => p.length > 0);
}

function layout(doc: PdfDocument, fonts: Fonts, body: number, canEncode: CanEncode): Row[][] {
  const m = metricsOf(body);
  const cols = columnsFor(fonts, body, doc);
  const head = tableHeader(fonts, m, cols);
  const items = itemRows(doc, fonts, m, cols, canEncode);
  const banner = bannerRows(doc, fonts, m, canEncode);
  const lineBlock: Block = items.length > 0
    ? { rows: [...head, ...items], repeat: [...banner, ...head] }
    : { rows: textRows(measurer(fonts.regular, body), "No line items", LEFT, m.body, WIDTH, m.leading, "regular", "muted", canEncode), repeat: banner };
  const header = headerRows(doc, fonts, m, canEncode);
  const summary = summaryRows(doc, fonts, m, canEncode);
  return pack([
    { rows: header },
    lineBlock,
    { rows: summary, repeat: banner },
  ]);
}

function drawPage(page: PDFPage, rows: Row[], fonts: Fonts, pageNo: number, pageCount: number) {
  let top = PAGE_H - MARGIN_TOP;
  for (const row of rows) {
    for (const piece of row.pieces) {
      // drawText would split on a leftover newline and drop a backspace. Neither belongs in a laid-out line.
      const text = piece.text.replace(/[\n\r\f\v\b\t]/g, " ");
      if (!text) continue;
      page.drawText(text, {
        x: piece.x,
        y: top - piece.baseline,
        size: piece.size,
        font: piece.font === "bold" ? fonts.bold : fonts.regular,
        color: piece.color === "muted" ? MUTED : INK,
      });
    }
    if (row.rule) {
      const y = top - row.height + 3;
      page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.6, color: RULE });
    }
    top -= row.height;
  }
  const footer = `Page ${pageNo} of ${pageCount}`;
  const size = 8;
  page.drawText(footer, {
    x: (PAGE_W - fonts.regular.widthOfTextAtSize(footer, size)) / 2,
    y: 18,
    size,
    font: fonts.regular,
    color: MUTED,
  });
}

/** Render one invoice. Page count is at most 3 for a 50-line invoice; the type shrinks until it fits. */
export async function renderInvoicePdf(doc: PdfDocument): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const canEncode = encoderFor(fonts.regular);
  let pages: Row[][] | undefined;
  for (const size of BODY_SIZES) {
    const laid = layout(doc, fonts, size, canEncode);
    if (laid.length <= 3) {
      pages = laid;
      break;
    }
  }
  pages ??= layout(doc, fonts, BODY_SIZES[BODY_SIZES.length - 1], canEncode);
  for (let i = 0; i < pages.length; i++) {
    drawPage(pdf.addPage([PAGE_W, PAGE_H]), pages[i], fonts, i + 1, pages.length);
  }
  const title = pdfFilename(doc.number).replace(/\.pdf$/, "");
  pdf.setTitle(title);
  pdf.setProducer("09-invoicing");
  const bytes = await pdf.save();
  return { bytes, pageCount: pages.length };
}

/** Nothing is due once the invoice is paid or void. Otherwise the stored total minus the stored paid cents. */
function balanceDue(status: string, totalCents: number, paidCents: number): number {
  if (status === "paid" || status === "void") return 0;
  return totalCents - paidCents;
}

async function billToFor(actor: Actor, detail: InvoiceDetail): Promise<PdfParty> {
  const snap = detail.invoice.clientSnapshot;
  // A sent invoice keeps the snapshot. The live client can be renamed later; the PDF must not follow it.
  if (snap) return { name: snap.name, address: snap.address, email: snap.email ?? "" };
  if (!detail.invoice.clientId) return { name: detail.clientName ?? "", address: "", email: "" };
  const [row] = await db()
    .select({ name: client.name, address: client.address, email: client.email })
    .from(client)
    .where(ownedBy(client, actor, eq(client.id, detail.invoice.clientId)));
  return { name: row?.name ?? detail.clientName ?? "", address: row?.address ?? "", email: row?.email ?? "" };
}

/** The owner's PDF. `getInvoice` applies `ownedBy` and `assertCan`, so another user and an admin get the same 404. */
export async function ownerInvoicePdf(actor: Actor, id: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const detail = await getInvoice(actor, id);
  const [profile] = await db()
    .select({ name: businessProfile.name, address: businessProfile.address, contactEmail: businessProfile.contactEmail })
    .from(businessProfile)
    .where(eq(businessProfile.ownerId, actor.id));
  const inv = detail.invoice;
  const { bytes } = await renderInvoicePdf({
    number: inv.number,
    status: inv.status,
    overdue: inv.overdue,
    from: { name: profile?.name ?? "", address: profile?.address ?? "", email: profile?.contactEmail ?? "" },
    billTo: await billToFor(actor, detail),
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    memo: inv.memo,
    voidReason: inv.voidReason ?? "",
    lines: detail.lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      quantityX100: l.quantityX100,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
    })),
    subtotalCents: inv.subtotalCents,
    taxBp: inv.taxBp,
    taxCents: inv.taxCents,
    totalCents: inv.totalCents,
    paidCents: inv.paidCents,
    balanceCents: balanceDue(inv.status, inv.totalCents, inv.paidCents),
  });
  return { bytes, filename: pdfFilename(inv.number) };
}

/**
 * The client's PDF. Uses `resolveShareToken`, the same lookup as `GET /api/public/invoices/:token`: a draft, a
 * malformed token, an unknown token and a rotated one are all null. Client email and address are omitted, as on that route.
 */
export async function publicInvoicePdf(token: unknown): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const row = await resolveShareToken(token);
  if (!row?.number) return null;
  const [lines, [profile]] = await Promise.all([
    db()
      .select({
        kind: invoiceLine.kind,
        description: invoiceLine.description,
        quantityX100: invoiceLine.quantityX100,
        unitPriceCents: invoiceLine.unitPriceCents,
        amountCents: invoiceLine.amountCents,
      })
      .from(invoiceLine)
      .where(and(eq(invoiceLine.invoiceId, row.id), eq(invoiceLine.ownerId, row.ownerId)))
      .orderBy(asc(invoiceLine.position)),
    db()
      .select({
        name: businessProfile.name,
        address: businessProfile.address,
        contactEmail: businessProfile.contactEmail,
        timeZone: businessProfile.timeZone,
      })
      .from(businessProfile)
      .where(eq(businessProfile.ownerId, row.ownerId)),
  ]);
  const status = row.status;
  const { bytes } = await renderInvoicePdf({
    number: row.number,
    status,
    overdue: status === "sent" && row.dueDate < todayIn(profile?.timeZone ?? "UTC"),
    from: { name: profile?.name ?? "", address: profile?.address ?? "", email: profile?.contactEmail ?? "" },
    // Name only: the public JSON (`getPublicInvoice`) omits the client's address and email, so the PDF does too.
    billTo: { name: row.clientSnapshot?.name ?? "", address: "", email: "" },
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    memo: row.memo,
    voidReason: "",
    lines,
    subtotalCents: row.subtotalCents,
    taxBp: row.taxBp,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    balanceCents: balanceDue(status, row.totalCents, row.paidCents),
  });
  return { bytes, filename: pdfFilename(row.number) };
}
