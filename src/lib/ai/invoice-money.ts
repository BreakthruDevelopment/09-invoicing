/**
 * Integer-cents arithmetic for the invoice-from-notes task.
 *
 * TODO(9.1): issue 9.1 adds `src/lib/money.ts` (spec "Money rules"). It wasn't on main when this was written,
 * so these two helpers follow the same rules locally: amounts are integer cents, quantity is `quantity_x100`
 * (2 decimals), line amount = round_half_up(quantity_x100 * unit_price_cents / 100) computed in bigint.
 * When money.ts lands, delete this file and import its line-amount and sum helpers instead.
 */

/** Line amount in cents: round half up of quantityX100 * unitPriceCents / 100. Both inputs must be non-negative integers. */
export function lineAmountCents(quantityX100: number, unitPriceCents: number): number {
  if (!Number.isSafeInteger(quantityX100) || !Number.isSafeInteger(unitPriceCents) || quantityX100 < 0 || unitPriceCents < 0) {
    throw new RangeError("Quantity and price must be non-negative integers");
  }
  const product = BigInt(quantityX100) * BigInt(unitPriceCents);
  return Number((product + BigInt(50)) / BigInt(100));
}

export function sumCents(values: readonly number[]): number {
  return Number(values.reduce((total, v) => total + BigInt(v), BigInt(0)));
}
