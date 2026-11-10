import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { draftInvoiceFromNotes } from "@/lib/invoice-draft";

export const dynamic = "force-dynamic";
// AI call is capped at 20 s (AI_TIMEOUT_MS); Lambda's hard limit is 29 s.
export const maxDuration = 25;

/**
 * POST /api/invoices/draft-from-notes
 * body: { notes: string (max 6,000), clientId: uuid, period?: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } }
 * The client must be the caller's; its hourly rate is looked up on the server (a `clientRateCents` field is a 400).
 * `period` defaults to the 7 days ending today in the owner's time zone.
 * Returns { draft: { draftId, clientId, period, lines, subtotalCents, assumptions, unbillable, dropped, demo } }.
 * The notes and the validated answer are saved server-side (last 20 per owner); nothing is on an invoice yet.
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
