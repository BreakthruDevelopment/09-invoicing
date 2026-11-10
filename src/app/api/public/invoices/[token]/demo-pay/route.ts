import { PUBLIC_HEADERS } from "@/lib/api";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { checkoutBody, confirmDemoPayment } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * POST /api/public/invoices/:token/demo-pay: confirm the demo payment ("Demo payment, no money moves"). 404 unless
 * the provider is `demo`. The demo page's Confirm button calls this (or the `confirmDemoPayment` action directly).
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) {
      return Response.json({ error: "Too many requests" }, { status: 429, headers: { ...PUBLIC_HEADERS, "Retry-After": "60" } });
    }
    requireSameOrigin(request);
    const raw = await readBodyCapped(request, 1024);
    checkoutBody.parse(raw.length === 0 ? {} : parseJsonBody(raw));
    return Response.json(await confirmDemoPayment((await ctx.params).token), { headers: PUBLIC_HEADERS });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.headers.set(k, v);
    return res;
  }
}
