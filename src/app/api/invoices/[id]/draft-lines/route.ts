import { type IdContext, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { addDraftLinesToInvoice } from "@/lib/invoice-draft";
import { JSON_LIMIT } from "@/lib/invoice-schemas";

export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/:id/draft-lines ("Add to invoice")
 * body: { draftId: uuid, lineIndexes: int[] (0-based positions in the draft's `lines`), version: int }
 * Draft invoices only. Quantity, rate and amounts are re-derived on the server; the body can't carry them.
 * Returns the invoice detail (same shape as GET /api/invoices/:id). A draft can be added once.
 */
export async function POST(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok(await addDraftLinesToInvoice(user, (await ctx.params).id, await readJson(request, JSON_LIMIT)));
  } catch (err) {
    return errorResponse(err);
  }
}
