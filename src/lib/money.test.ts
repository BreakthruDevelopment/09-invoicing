import { describe, expect, it } from "vitest";
import { MAX_LINES, computeTotals, divRoundHalfUp, lineAmountCents, sumCents, taxCents } from "./money";

describe("lineAmountCents: round half up, once per line", () => {
  // [quantityX100, unitPriceCents, expected cents]
  const table: [number, number, number][] = [
    [100, 10_000, 10_000], // 1 x $100.00
    [350, 10_000, 35_000], // 3.5 h at $100/h
    [150, 333, 500], // 499.5 rounds up
    [1, 50, 1], // 0.5 rounds up
    [1, 49, 0], // 0.49 rounds down
    [1, 51, 1], // 0.51
    [250, 1_001, 2_503], // 2502.5 -> 2503
    [25, 10_001, 2_500], // 2500.25 -> 2500
    [75, 10_001, 7_501], // 7500.75 -> 7501
    [33, 3_333, 1_100], // 1099.89 -> 1100
    [0, 10_000, 0], // zero quantity
    [100, 0, 0], // zero price
    [9_999_999, 100_000, 9_999_999_000], // 99,999.99 x $1,000.00
    [9_999_999, 10_000_000, 999_999_900_000], // the largest line; far beyond 2^31
  ];
  it.each(table)("%d x %d cents = %d", (q, p, expected) => {
    expect(lineAmountCents(q, p)).toBe(expected);
  });

  it("refuses negatives, fractions and unsafe numbers", () => {
    expect(() => lineAmountCents(-1, 100)).toThrow(RangeError);
    expect(() => lineAmountCents(1, -100)).toThrow(RangeError);
    expect(() => lineAmountCents(1.5, 100)).toThrow(RangeError);
    expect(() => lineAmountCents(1, Number.NaN)).toThrow(RangeError);
    expect(() => lineAmountCents(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
    expect(() => lineAmountCents(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

describe("taxCents: round half up, once, on the subtotal", () => {
  const table: [number, number, number][] = [
    [10_000, 825, 825], // 8.25% of $100.00
    [1_999, 825, 165], // 164.9175 -> 165
    [100, 5, 0], // 0.05 -> 0
    [1_000, 5, 1], // exactly 0.5 -> 1
    [10_000, 0, 0],
    [0, 3_000, 0],
    [12_345, 3_000, 3_704], // 3703.5 -> 3704
  ];
  it.each(table)("%d cents at %d bp", (subtotal, bp, expected) => {
    expect(taxCents(subtotal, bp)).toBe(expected);
  });
});

describe("computeTotals", () => {
  it("rounds each line, then adds, then taxes the subtotal once", () => {
    // Three lines of 0.5 cents each round up to 1 cent (3 in all); summing first would give round(1.5) = 2.
    const t = computeTotals(Array.from({ length: 3 }, () => ({ quantityX100: 1, unitPriceCents: 50 })), 0);
    expect(t.lineAmounts).toEqual([1, 1, 1]);
    expect(t.subtotalCents).toBe(3);
    expect(t.totalCents).toBe(3);
  });

  it("adds tax to the subtotal", () => {
    const t = computeTotals([{ quantityX100: 350, unitPriceCents: 10_000 }, { quantityX100: 100, unitPriceCents: 12_900 }], 825);
    expect(t.subtotalCents).toBe(47_900);
    expect(t.taxCents).toBe(3_952); // 3951.75
    expect(t.totalCents).toBe(51_852);
  });

  it("handles the 50-line maximum and refuses a 51st", () => {
    const lines = Array.from({ length: MAX_LINES }, (_, i) => ({ quantityX100: 100 + i, unitPriceCents: 333 }));
    const t = computeTotals(lines, 700);
    const expectedLines = lines.map((l) => Math.floor((l.quantityX100 * 333 * 2 + 100) / 200));
    expect(t.lineAmounts).toEqual(expectedLines);
    expect(t.subtotalCents).toBe(expectedLines.reduce((a, b) => a + b, 0));
    expect(t.totalCents).toBe(t.subtotalCents + t.taxCents);
    expect(() => computeTotals([...lines, lines[0]], 0)).toThrow(RangeError);
  });

  it("stays exact at the largest possible invoice (50 lines of 99,999.99 x $100,000.00)", () => {
    const lines = Array.from({ length: MAX_LINES }, () => ({ quantityX100: 9_999_999, unitPriceCents: 10_000_000 }));
    const t = computeTotals(lines, 3_000);
    expect(t.subtotalCents).toBe(50 * 999_999_900_000);
    expect(t.taxCents).toBe(Math.round(t.subtotalCents * 0.3));
    expect(Number.isSafeInteger(t.totalCents)).toBe(true);
  });

  it("refuses a bad tax rate", () => {
    expect(() => computeTotals([], -1)).toThrow(RangeError);
    expect(() => computeTotals([], 3_001)).toThrow(RangeError);
    expect(() => computeTotals([], 1.5)).toThrow(RangeError);
  });

  it("an empty invoice is all zeros", () => {
    expect(computeTotals([], 825)).toEqual({ lineAmounts: [], subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });
});

describe("helpers", () => {
  it("sumCents adds integers exactly and refuses bad values", () => {
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([1, -2])).toThrow(RangeError);
  });
  it("divRoundHalfUp rounds exact halves up", () => {
    expect(divRoundHalfUp(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(divRoundHalfUp(BigInt(4), BigInt(2))).toBe(BigInt(2));
    expect(divRoundHalfUp(BigInt(1), BigInt(3))).toBe(BigInt(0));
    expect(divRoundHalfUp(BigInt(2), BigInt(3))).toBe(BigInt(1));
  });
});
