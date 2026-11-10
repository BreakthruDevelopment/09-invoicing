import { type IdContext, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { duplicateInvoice } from "@/lib/invoices";

export const dynamic = "force-dynamic";

/** POST /api/invoices/:id/duplicate: a new draft with the same client, lines, tax and memo. */
export async function POST(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok(await duplicateInvoice(user, (await ctx.params).id), 201);
  } catch (err) {
    return errorResponse(err);
  }
}
