import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimited } from "@/components/invoicing/rate-limited";
import { PUBLIC_LIMIT_PER_MINUTE, allowPublicRequest, resetPublicLimiter } from "@/lib/ip-limit";

const getPublicInvoice = vi.fn(async () => null);
vi.mock("@/lib/share", () => ({ getPublicInvoice }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }),
}));

const TOKEN = "a".repeat(43);

describe("public HTML pages share the per-IP limit", () => {
  beforeEach(() => {
    resetPublicLimiter();
    getPublicInvoice.mockClear();
  });

  it("the invoice page renders the too-many-requests state and never looks up the invoice", async () => {
    const { default: Page } = await import("./page");
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) allowPublicRequest("7.7.7.7"); // the last entry is the key
    const el = await Page({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) });
    expect(el.type).toBe(RateLimited);
    expect(getPublicInvoice).not.toHaveBeenCalled();
  });

  it("the demo-pay page does the same", async () => {
    const { default: Page } = await import("./demo-pay/page");
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) allowPublicRequest("7.7.7.7");
    const el = await Page({ params: Promise.resolve({ token: TOKEN }) });
    expect(el.type).toBe(RateLimited);
    expect(getPublicInvoice).not.toHaveBeenCalled();
  });

  it("under the limit the lookup runs (an unknown token is a 404, not the limited state)", async () => {
    const { default: Page } = await import("./page");
    await expect(Page({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) })).rejects.toThrow();
    expect(getPublicInvoice).toHaveBeenCalledTimes(1);
  });
});
