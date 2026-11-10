/**
 * Money, in one module. Nothing else in the app does arithmetic on amounts, and nothing runs in the browser or in a
 * model: totals are computed here, on the server, from the lines in the database.
 *
 * Rules (also in the spec's "Money rules"):
 * - Every amount is an integer number of cents (USD). Floats never touch money.
 * - A quantity is stored as `quantityX100`: hundredths of a unit, 1 to 9,999,999 (0.01 to 99,999.99).
 * - Line amount = round_half_up(quantityX100 * unitPriceCents / 100), rounded once per line, so the lines on the
 *   page always add up to the subtotal.
 * - Tax = round_half_up(subtotal * taxBp / 10,000), rounded once on the subtotal (never per line), with the rate in
 *   basis points (0 to 3,000 = 0% to 30%). Total = subtotal + tax. Tax is not charged on a zero subtotal.
 * - "Half up" means exactly half rounds away from zero; all amounts here are non-negative, so that is up.
 * - The products are computed in `bigint` (a $100,000 price times 99,999.99 units is over 2^53 / 1000), and the
 *   result must fit a safe JS integer or a `RangeError` is thrown.
 * - An invoice has at most 50 lines.
 */

export const MAX_LINES = 50;
export const MIN_QUANTITY_X100 = 1;
export const MAX_QUANTITY_X100 = 9_999_999;
export const MAX_UNIT_PRICE_CENTS = 10_000_000;
export const MAX_TAX_BP = 3_000;

const ZERO = BigInt(0);
const TWO = BigInt(2);

function nonNegativeInt(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Amount is too large");
  return Number(value);
}

/** round_half_up(numerator / denominator) for a non-negative numerator and a positive denominator. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < ZERO || denominator <= ZERO) throw new RangeError("divRoundHalfUp needs numerator >= 0 and denominator > 0");
  return (numerator * TWO + denominator) / (denominator * TWO);
}

/** Line amount in cents: round half up of quantityX100 * unitPriceCents / 100. Both inputs are non-negative integers. */
export function lineAmountCents(quantityX100: number, unitPriceCents: number): number {
  const product = nonNegativeInt(quantityX100, "Quantity") * nonNegativeInt(unitPriceCents, "Price");
  return toSafeNumber(divRoundHalfUp(product, BigInt(100)));
}

/** Tax in cents on a subtotal: round half up of subtotalCents * taxBp / 10,000. */
export function taxCents(subtotalCents: number, taxBp: number): number {
  const product = nonNegativeInt(subtotalCents, "Subtotal") * nonNegativeInt(taxBp, "Tax rate");
  return toSafeNumber(divRoundHalfUp(product, BigInt(10_000)));
}

export function sumCents(values: readonly number[]): number {
  return toSafeNumber(values.reduce((total, v) => total + nonNegativeInt(v, "Amount"), ZERO));
}

export type MoneyLine = { quantityX100: number; unitPriceCents: number };
export type Totals = { lineAmounts: number[]; subtotalCents: number; taxCents: number; totalCents: number };

/** Everything an invoice stores or shows, from its lines and tax rate. The only place totals are made. */
export function computeTotals(lines: readonly MoneyLine[], taxBp: number): Totals {
  if (lines.length > MAX_LINES) throw new RangeError(`An invoice has at most ${MAX_LINES} lines`);
  if (!Number.isInteger(taxBp) || taxBp < 0 || taxBp > MAX_TAX_BP) throw new RangeError(`Tax rate must be 0 to ${MAX_TAX_BP} basis points`);
  const lineAmounts = lines.map((l) => lineAmountCents(l.quantityX100, l.unitPriceCents));
  const subtotalCents = sumCents(lineAmounts);
  const tax = taxCents(subtotalCents, taxBp);
  return { lineAmounts, subtotalCents, taxCents: tax, totalCents: toSafeNumber(BigInt(subtotalCents) + BigInt(tax)) };
}

/** "$1,234.50" from integer cents. Display only; never parse this back. */
export function formatCents(value: number): string {
  const v = nonNegativeInt(value, "Amount");
  const dollars = (v / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${(v % BigInt(100)).toString().padStart(2, "0")}`;
}
