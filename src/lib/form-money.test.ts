import { describe, expect, it } from "vitest";
import { formatQuantity, formatTaxPercent, parseCents, parseQuantityX100, parseTaxBp } from "./form-money";

describe("form money parsers", () => {
  it("reads quantities as hundredths and prints them back", () => {
    expect(parseQuantityX100("3.5")).toBe(350);
    expect(parseQuantityX100("3.50")).toBe(350);
    expect(parseQuantityX100("1")).toBe(100);
    expect(parseQuantityX100("0.01")).toBe(1);
    expect(parseQuantityX100("10.1")).toBe(1010);
    expect(parseQuantityX100("99999.99")).toBe(9_999_999);
    expect(formatQuantity(350)).toBe("3.5");
    expect(formatQuantity(100)).toBe("1");
    expect(formatQuantity(1010)).toBe("10.1");
    expect(parseQuantityX100(formatQuantity(1010))).toBe(1010);
  });

  it("rejects a zero, blank or oversized quantity", () => {
    expect(parseQuantityX100("")).toBeNull();
    expect(parseQuantityX100("0")).toBeNull();
    expect(parseQuantityX100("0.00")).toBeNull();
    expect(parseQuantityX100("100000")).toBeNull();
    expect(parseQuantityX100("1.234")).toBeNull();
    expect(parseQuantityX100("3,5")).toBeNull();
  });

  it("reads dollar inputs as cents, including commas", () => {
    expect(parseCents("100")).toBe(10_000);
    expect(parseCents("100.00")).toBe(10_000);
    expect(parseCents("$129.5")).toBe(12_950);
    expect(parseCents("1,000.00")).toBe(100_000);
    expect(parseCents("100000.00")).toBe(10_000_000);
    expect(parseCents("100000.01")).toBeNull();
    expect(parseCents("100.00", 100_000)).toBe(10_000);
    expect(parseCents("1000.01", 100_000)).toBeNull();
    expect(parseCents("")).toBeNull();
    expect(parseCents("-1")).toBeNull();
  });

  it("reads a tax percent as basis points, capped at 30%", () => {
    expect(parseTaxBp("")).toBe(0);
    expect(parseTaxBp("0")).toBe(0);
    expect(parseTaxBp("8.25")).toBe(825);
    expect(parseTaxBp("8.2")).toBe(820);
    expect(parseTaxBp("8.25%")).toBe(825);
    expect(parseTaxBp("30")).toBe(3_000);
    expect(parseTaxBp("30.01")).toBeNull();
    expect(formatTaxPercent(825)).toBe("8.25");
    expect(formatTaxPercent(800)).toBe("8");
    expect(parseTaxBp(formatTaxPercent(825))).toBe(825);
  });
});
