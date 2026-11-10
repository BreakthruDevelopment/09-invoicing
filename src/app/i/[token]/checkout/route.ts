import { PUBLIC_HEADERS } from "@/lib/api";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readBodyCapped, parseJsonBody } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { checkoutBody, startCheckout } from "@/lib/payments";

export const dynamic = "force-dynamic";
export const maxDuration = 20; // the Stripe call times out at 8 s; stay well inside the platform's 29 s

/**
 * POST /i/:token/checkout: the payer (no login, only the share link) starts a payment. There is no amount in the
 * request: the server charges the invoice balance. Answers `{ provider, url }`; the page sends the payer to `url`
 * (our demo page, or Stripe Checkout in test mode). Paying is only ever recorded by the demo confirm step or the
 * signed webhook, never by this route or by the return from Stripe.
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) {
      return Response.json({ error: "Too many requests" }, { status: 429, headers: { ...PUBLIC_HEADERS, "Retry-After": "60" } });
    }
    requireSameOrigin(request);
    const raw = await readBodyCapped(request, 1024);
    checkoutBody.parse(raw.length === 0 ? {} : parseJsonBody(raw));
    const result = await startCheckout((await ctx.params).token);
    return Response.json(result, { headers: PUBLIC_HEADERS });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.headers.set(k, v);
    return res;
  }
}
