import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { errorResponse } from "@/lib/http";
import { getPublicInvoice } from "@/lib/share";

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

/**
 * GET /api/public/invoices/:token: what the client's page shows, for a sent, paid or void invoice. No session.
 * Unknown, malformed, rotated, revoked and draft all answer the same 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) {
      return Response.json({ error: "Too many requests" }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
    }
    const invoice = await getPublicInvoice((await ctx.params).token);
    if (!invoice) return Response.json({ error: "Not found" }, { status: 404, headers: HEADERS });
    return Response.json({ invoice }, { headers: HEADERS });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
    return res;
  }
}
