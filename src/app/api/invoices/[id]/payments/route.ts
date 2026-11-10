import { type IdContext, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";
import { recordManualPayment } from "@/lib/invoices";

export const dynamic = "force-dynamic";

/** POST /api/invoices/:id/payments: body { version, note? }. Records the full balance as paid. */
export async function POST(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok(await recordManualPayment(user, (await ctx.params).id, await readJson(request, JSON_LIMIT)));
  } catch (err) {
    return errorResponse(err);
  }
}
