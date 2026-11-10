import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { draftInvoiceFromNotes } from "@/lib/invoice-draft";

export const dynamic = "force-dynamic";
// AI call is capped at 20 s (AI_TIMEOUT_MS); Lambda's hard limit is 29 s.
export const maxDuration = 25;

/**
 * POST /api/invoices/draft-from-notes
 * body: { notes: string (max 6,000), clientRateCents: int, period?: { from, to } }
 * Returns the verified draft (lines with evidence, subtotal, assumptions, dropped). Nothing is saved.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const draft = await draftInvoiceFromNotes(user, await readJson(request, 32 * 1024));
    return Response.json({ draft }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
