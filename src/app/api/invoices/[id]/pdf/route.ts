import { type IdContext } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { ownerInvoicePdf, pdfResponse } from "@/lib/pdf";

export const dynamic = "force-dynamic";
/** Rendering stays inside the spec's 3 s PDF budget, and well under the platform's 29 s limit. */
export const maxDuration = 5;

/** GET /api/invoices/:id/pdf — the owner's copy, generated for this request and not stored. */
export async function GET(_request: Request, ctx: IdContext) {
  try {
    const user = await requireUser();
    const pdf = await ownerInvoicePdf(user, (await ctx.params).id);
    return pdfResponse(pdf.bytes, pdf.filename);
  } catch (err) {
    return errorResponse(err);
  }
}
