import { MAX_QUANTITY_X100, MAX_TAX_BP, MAX_UNIT_PRICE_CENTS, MIN_QUANTITY_X100 } from "@/lib/money";

/**
 * Turn what a person types into the integers the API stores.
 * Quantity is hundredths of a unit (`3.5` → 350). Money is cents (`100.00` → 10000).
 * Tax is a percent with up to two decimals (`8.25` → 825 basis points).
 * These parsers do not compute invoice totals. `money.ts` does that, on the server.
 */

function parts(raw: string): { whole: string; frac: string } | null {
  const [whole, frac = ""] = raw.split(".");
  if (!/^\d+$/.test(whole)) return null;
  return { whole, frac };
}

function scaled(whole: string, frac: string): number {
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** `3.5` → 350. Blank, zero and anything outside 0.01–99,999.99 is null. A trailing dot is allowed while typing. */
export function parseQuantityX100(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,5}(\.\d{0,2})?$/.test(t)) return null;
  const parsed = parts(t);
  if (!parsed) return null;
  const value = scaled(parsed.whole, parsed.frac);
  if (!Number.isSafeInteger(value) || value < MIN_QUANTITY_X100 || value > MAX_QUANTITY_X100) return null;
  return value;
}

/** 350 → `3.5`, 100 → `1`, 1010 → `10.1`. Display only. */
export function formatQuantity(quantityX100: number): string {
  const whole = Math.trunc(quantityX100 / 100);
  const frac = Math.abs(quantityX100 % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** `100.00`, `$100`, or `1,000.00` → cents. Above `max` (default $100,000) is null. */
export function parseCents(raw: string, max = MAX_UNIT_PRICE_CENTS): number | null {
  const t = raw.trim().replace(/[$,\s]/g, "");
  if (t === "") return null;
  if (!/^\d{1,8}(\.\d{0,2})?$/.test(t)) return null;
  const parsed = parts(t);
  if (!parsed) return null;
  const value = scaled(parsed.whole, parsed.frac);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value;
}

/** Cents → `100.00` for an input's default value. */
export function formatCentsInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/** `8.25` or `8.25%` → 825. Empty is 0. Above 30% is null. */
export function parseTaxBp(raw: string): number | null {
  const t = raw.trim().replace(/%$/, "").trim();
  if (t === "") return 0;
  if (!/^\d{1,2}(\.\d{0,2})?$/.test(t)) return null;
  const parsed = parts(t);
  if (!parsed) return null;
  const value = scaled(parsed.whole, parsed.frac);
  if (!Number.isInteger(value) || value < 0 || value > MAX_TAX_BP) return null;
  return value;
}

/** 825 → `8.25`, 800 → `8`. */
export function formatTaxPercent(taxBp: number): string {
  const whole = Math.trunc(taxBp / 100);
  const frac = Math.abs(taxBp % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function formatTaxLabel(taxBp: number): string {
  return `${formatTaxPercent(taxBp)}%`;
}
