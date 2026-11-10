import { type IdContext, ok, shareUrl } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";
import { transitionInvoice } from "@/lib/invoices";

export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/:id/transition: body { to: "sent" | "void", version, reason? }.
 * Sending returns `shareUrl` once; it can't be shown again (only a hash is stored), but it can be rotated.
 */
export async function POST(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { detail, shareToken } = await transitionInvoice(user, (await ctx.params).id, await readJson(request, JSON_LIMIT));
    return ok({ ...detail, ...(shareToken ? { shareUrl: shareUrl(shareToken) } : {}) });
  } catch (err) {
    return errorResponse(err);
  }
}
