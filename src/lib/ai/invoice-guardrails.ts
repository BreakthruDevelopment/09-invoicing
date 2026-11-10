import type { InvoiceDraftModelOutput } from "./invoice-from-notes";
import { lineAmountCents } from "./invoice-money";

/** A line is dropped above this amount ($50,000) or at $0. */
export const MAX_LINE_AMOUNT_CENTS = 5_000_000;

export type DropCode =
  | "bad_citation"
  | "evidence_missing"
  | "evidence_mismatch"
  | "injection"
  | "bad_quantity"
  | "digit_rule"
  | "no_price"
  | "amount_zero"
  | "amount_over_cap"
  | "duplicate";

export type DroppedLine = { code: DropCode; reason: string; description: string };

export type DraftLine = {
  kind: "hours" | "fixed" | "expense";
  description: string;
  quantityX100: number;
  unitPriceCents: number;
  amountCents: number;
  sourceLines: string[];
  evidence: string;
  source: "ai";
};

export type GuardrailResult = {
  lines: DraftLine[];
  assumptions: string[];
  unbillable: string[];
  dropped: DroppedLine[];
};

const REASONS: Record<DropCode, string> = {
  bad_citation: "cited a note line that doesn't exist",
  evidence_missing: "no quoted evidence",
  evidence_mismatch: "the quoted evidence isn't in the cited note lines",
  injection: "the cited note text looks like an instruction, not work",
  bad_quantity: "the quantity isn't a usable amount",
  digit_rule: "the quantity isn't stated in the evidence",
  no_price: "no price found in the cited note lines",
  amount_zero: "the amount is $0",
  amount_over_cap: "the amount is above $50,000",
  duplicate: "the same work is already on another line",
};

/** Phrases that mean a note line is talking to the model rather than describing work. */
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|prompts?|rules|previous|above|prior)\b/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\byou (are now|will now)\b/i,
  /\bas an ai\b/i,
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Every `$` amount in the text, in cents. */
export function pricesInText(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const dollars = Number(m[1].replace(/,/g, ""));
    const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    out.add(dollars * 100 + cents);
  }
  return out;
}

const TIME_RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;

function minutes(h: string, m: string | undefined, meridiem: string | undefined): number | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (min > 59) return null;
  const mer = meridiem?.toLowerCase();
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return hour * 60 + min;
}

/**
 * Time ranges such as `9:00-11:30` or `9am to 12:30pm` in `text`: their total in minutes, and the text with
 * the ranges removed. A bare `10-12` isn't a range: one side needs a colon or am/pm.
 */
export function timeRanges(text: string): { totalMinutes: number; rest: string; count: number } {
  let total = 0;
  let count = 0;
  const rest = text.replace(TIME_RANGE, (whole, h1, m1, a1, h2, m2, a2) => {
    const explicit = m1 || m2 || a1 || a2;
    if (!explicit) return whole;
    const start = minutes(h1, m1, a1);
    let end = minutes(h2, m2, a2);
    if (start === null || end === null) return whole;
    if (end <= start && !a2) end += 12 * 60; // "9-5" with no am/pm
    if (end <= start) return whole;
    total += end - start;
    count += 1;
    return " ";
  });
  return { totalMinutes: total, rest, count };
}

const WORD = /[A-Za-z0-9]/;

/**
 * Where `evidence` sits inside one note line, on word boundaries: it can't start or end in the middle of a word
 * or number (`$100` is not evidence for `$1000`, `$129` not for `$129.50`). Both arguments are already normalized.
 */
function quotedIn(line: string, evidence: string): boolean {
  for (let at = line.indexOf(evidence); at !== -1; at = line.indexOf(evidence, at + 1)) {
    const before = line[at - 1];
    const after = line[at + evidence.length];
    const first = evidence[0];
    const last = evidence[evidence.length - 1];
    if (WORD.test(first) && before !== undefined && (WORD.test(before) || before === "$" || (/[.,]/.test(before) && /\d/.test(line[at - 2] ?? "")))) continue;
    if (WORD.test(last) && after !== undefined && (WORD.test(after) || (/[.,]/.test(after) && /\d/.test(line[at + evidence.length + 1] ?? "")))) continue;
    return true;
  }
  return false;
}

/** Evidence text with clock times and dollar amounts removed, so their digits can't pass for a quantity. */
function withoutTimesAndPrices(text: string): string {
  return text
    .replace(/\d{1,2}:\d{2}/g, " ")
    .replace(/\d{1,2}\s?(?:am|pm)\b/gi, " ")
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ");
}

const HOURS_TOKEN = /(?<![\d.:$,])(\d+(?:\.\d+)?)\s?(?:h|hrs?|hours?)\b/gi;

/**
 * Quantity rule. Hours: one number written as `2h`, `1.5 hrs`, `3 hours` in the evidence, or the total of the time
 * ranges on the cited line. Other kinds: quantity 1, or a number token in the evidence (not a time or a price).
 */
function passesQuantityRule(kind: DraftLine["kind"], quantityX100: number, evidence: string, citedLine: string): boolean {
  const stripped = withoutTimesAndPrices(evidence);
  if (kind === "hours") {
    for (const m of stripped.matchAll(HOURS_TOKEN)) if (Math.round(Number(m[1]) * 100) === quantityX100) return true;
    const { totalMinutes, count } = timeRanges(citedLine);
    return count > 0 && Math.abs(Math.round((totalMinutes / 60) * 100) - quantityX100) <= 1;
  }
  if (quantityX100 === 100) return true; // one fee or one expense; its amount is checked by the price rule
  return (stripped.match(/(?<![\d.])\d+(?:\.\d+)?/g) ?? []).some((t) => Math.round(Number(t) * 100) === quantityX100);
}

/** An hourly rate written in the evidence itself: `$120/h`, `$120/hr`, `$120 per hour`, `$120 an hour`. */
const RATE_IN_EVIDENCE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:\/\s?(?:h|hrs?|hours?)\b|per hour\b|an hour\b)/i;

function rateInEvidence(evidence: string): number | null {
  const m = evidence.match(RATE_IN_EVIDENCE);
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}

/**
 * Checks every model line against the notes themselves; the model's word is never enough.
 * Lines that fail are dropped and reported (code and reason only, never note text). Amounts come from integer
 * cents arithmetic, never from the model.
 */
export function applyInvoiceGuardrails(
  model: InvoiceDraftModelOutput,
  ctx: { noteLines: readonly string[]; clientRateCents: number },
): GuardrailResult {
  const lines: DraftLine[] = [];
  const keys: { kind: string; quantityX100: number; cited: Set<number>; evidence: string }[] = [];
  const dropped: DroppedLine[] = [];
  const assumptions: string[] = [...model.assumptions];

  const drop = (code: DropCode, description: string, assume = false) => {
    dropped.push({ code, reason: REASONS[code], description: description.slice(0, 120) });
    if (assume) {
      assumptions.push(
        (code === "duplicate" ? `Dropped a duplicate line: ${description}` : `Couldn't verify: ${description}`).slice(0, 200),
      );
    }
  };

  for (const m of model.lines) {
    const indexes = m.sourceLines.map((s) => Number(s.slice(1)));
    if (indexes.some((n) => n < 1 || n > ctx.noteLines.length)) {
      drop("bad_citation", m.description);
      continue;
    }
    const cited = indexes.map((n) => ctx.noteLines[n - 1]);

    if (cited.some((c) => INJECTION_PATTERNS.some((p) => p.test(c))) || INJECTION_PATTERNS.some((p) => p.test(m.evidence))) {
      drop("injection", m.description);
      continue;
    }
    const evidence = norm(m.evidence);
    if (evidence.length < 2) {
      drop("evidence_missing", m.description, true);
      continue;
    }
    // Each cited line on its own: a quote can't join the end of one line to the start of the next.
    const citedLine = cited.map(norm).find((c) => quotedIn(c, evidence));
    if (citedLine === undefined) {
      drop("evidence_mismatch", m.description, true);
      continue;
    }

    const quantityX100 = Math.round(m.quantity * 100);
    if (quantityX100 < 1 || quantityX100 > 9_999_999) {
      drop("bad_quantity", m.description);
      continue;
    }
    if (!passesQuantityRule(m.kind, quantityX100, evidence, citedLine)) {
      drop("digit_rule", m.description, true);
      continue;
    }

    // Price rule. Hours: the client's rate, unless the evidence itself states a rate. Fixed and expense: the
    // price must be written inside the evidence.
    let unitPriceCents: number;
    if (m.kind === "hours") {
      const stated = rateInEvidence(evidence);
      unitPriceCents = stated ?? ctx.clientRateCents;
      if (stated === null && m.unitPriceCents !== null && m.unitPriceCents !== ctx.clientRateCents) {
        assumptions.push(`Used the client rate for "${m.description}"; the price the model gave isn't in the evidence.`.slice(0, 200));
      }
    } else if (m.unitPriceCents !== null && pricesInText(evidence).has(m.unitPriceCents)) {
      unitPriceCents = m.unitPriceCents;
    } else {
      drop("no_price", m.description, true);
      continue;
    }

    const amountCents = lineAmountCents(quantityX100, unitPriceCents);
    if (amountCents === 0) {
      drop("amount_zero", m.description);
      continue;
    }
    if (amountCents > MAX_LINE_AMOUNT_CENTS) {
      drop("amount_over_cap", m.description);
      continue;
    }

    // Same kind and quantity, a shared cited line, and one quote containing the other: the same work twice.
    const citedSet = new Set(indexes);
    const twin = keys.some(
      (k) =>
        k.kind === m.kind &&
        k.quantityX100 === quantityX100 &&
        indexes.some((n) => k.cited.has(n)) &&
        (k.evidence.includes(evidence) || evidence.includes(k.evidence)),
    );
    if (twin) {
      drop("duplicate", m.description, true);
      continue;
    }
    keys.push({ kind: m.kind, quantityX100, cited: citedSet, evidence });

    lines.push({
      kind: m.kind,
      description: m.description,
      quantityX100,
      unitPriceCents,
      amountCents,
      sourceLines: m.sourceLines,
      evidence: m.evidence,
      source: "ai",
    });
  }

  return { lines, assumptions: assumptions.slice(0, 10), unbillable: model.unbillable, dropped };
}
