import { type IdContext, ok, shareUrl } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { revokeShareToken, rotateShareToken } from "@/lib/share";

export const dynamic = "force-dynamic";

/** POST /api/invoices/:id/share: rotate the link. The old one stops working at once; the new URL is returned once. */
export async function POST(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { token } = await rotateShareToken(user, (await ctx.params).id);
    return ok({ shareUrl: shareUrl(token) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/invoices/:id/share: turn the link off. */
export async function DELETE(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    await revokeShareToken(user, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
