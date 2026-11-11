import { PUBLIC_HEADERS } from "@/lib/api";
import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { pdfResponse, publicInvoicePdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";
/** Rendering stays inside the spec's 3 s PDF budget, and well under the platform's 29 s limit. */
export const maxDuration = 5;

/**
 * GET /i/:token/pdf — the client's copy of a sent, paid or void invoice. No session. The token is resolved the
 * same way as the public invoice JSON; a draft, a bad token and a rotated one all answer the same 404.
 * Counted in the 60-requests-per-IP public limit.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) {
      return Response.json({ error: "Too many requests" }, { status: 429, headers: { ...PUBLIC_HEADERS, "Retry-After": "60" } });
    }
    const pdf = await publicInvoicePdf((await ctx.params).token);
    if (!pdf) return Response.json({ error: "Not found" }, { status: 404, headers: PUBLIC_HEADERS });
    return pdfResponse(pdf.bytes, pdf.filename, PUBLIC_HEADERS);
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.headers.set(k, v);
    return res;
  }
}
