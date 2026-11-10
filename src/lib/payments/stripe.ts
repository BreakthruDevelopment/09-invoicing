import "server-only";
import { z } from "zod";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";
import { CURRENCY, invoiceRef } from "./invoice-ref";

const STRIPE_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";
const TIMEOUT_MS = 8_000;
const EXPIRY_WINDOW_SECONDS = 1800;
/** Stripe refuses a card charge under 50 cents (USD). */
export const MIN_STRIPE_AMOUNT_CENTS = 50;

const sessionResponse = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
  url: z.string().url(),
});
const errorResponse = z.object({ error: z.object({ type: z.string().max(64).optional(), code: z.string().max(64).optional() }).optional() });

export type CheckoutInvoice = { id: string; number: string | null; totalCents: number; version: number; shareTokenHash: string | null };

const unavailable = () => new HttpError(502, "The payment provider is unavailable. Try again shortly.");

/**
 * A test-mode Checkout Session for the invoice balance, over plain `fetch` (8 s timeout, no SDK). The amount is the
 * caller's server-computed balance. The idempotency key repeats for the same invoice version and link, so a retry
 * returns the same session instead of a second one. Nothing here is logged except status and Stripe's error codes.
 */
export async function createStripeCheckout(
  secretKey: string,
  invoice: CheckoutInvoice,
  balanceCents: number,
  token: string,
  appOrigin: string,
): Promise<{ url: string; sessionId: string }> {
  const back = `${appOrigin}/i/${token}`;
  const window = Math.floor(Date.now() / 1000 / EXPIRY_WINDOW_SECONDS);
  const expiresAt = (window + 3) * EXPIRY_WINDOW_SECONDS;
  const form = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": CURRENCY,
    "line_items[0][price_data][unit_amount]": String(balanceCents),
    "line_items[0][price_data][product_data][name]": `Invoice ${invoice.number ?? ""}`.trim(),
    "metadata[invoice_id]": invoice.id,
    "metadata[invoice_hash]": invoiceRef(invoice),
    // Stripe's default is 24 h; an hour is plenty to pay. Aligned to 30-minute windows (60-90 min ahead) so a retry in the
    // same window sends identical parameters and the idempotency key below stays valid.
    expires_at: String(expiresAt),
    success_url: `${back}?payment=processing`,
    cancel_url: `${back}?payment=cancelled`,
  });

  let res: Response;
  try {
    res = await fetch(STRIPE_SESSIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // The link's hash prefix keeps the key unique per link: Stripe rejects a reused key whose parameters changed,
        // and rotating the link changes the return URLs.
        "Idempotency-Key": `invoice-${invoice.id}-v${invoice.version}-${(invoice.shareTokenHash ?? "").slice(0, 8)}-w${window}`,
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    log.warn("stripe.checkout_failed", { invoiceId: invoice.id, reason: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network" });
    throw unavailable();
  }

  if (!res.ok) {
    const body = errorResponse.safeParse(await res.json().catch(() => null));
    log.warn("stripe.checkout_failed", { invoiceId: invoice.id, status: res.status, type: body.data?.error?.type, code: body.data?.error?.code });
    throw unavailable();
  }
  const parsed = sessionResponse.safeParse(await res.json().catch(() => null));
  // Only ever send the payer to Stripe's own checkout host.
  if (!parsed.success || new URL(parsed.data.url).protocol !== "https:" || new URL(parsed.data.url).hostname !== "checkout.stripe.com") {
    log.warn("stripe.checkout_failed", { invoiceId: invoice.id, reason: "bad_response" });
    throw unavailable();
  }
  return { url: parsed.data.url, sessionId: parsed.data.id };
}
