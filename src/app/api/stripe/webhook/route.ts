import { errorResponse, readBodyCapped } from "@/lib/http";
import { WEBHOOK_BODY_LIMIT, handleStripeWebhook } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * POST /api/stripe/webhook: Stripe calls this; there is no session and (deliberately) no same-origin check, because
 * Stripe sends no Origin header. The Stripe-Signature header is the only authentication. The raw body (at most
 * 64 KB) is read once, as bytes, and verified before anything is parsed; no zod here because the HMAC covers the
 * exact bytes, and the verified event is validated inside the handler.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await readBodyCapped(request, WEBHOOK_BODY_LIMIT);
    const result = await handleStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
