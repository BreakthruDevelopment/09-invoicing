import { type IdContext, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";
import { deleteInvoice, getInvoice, updateInvoice } from "@/lib/invoices";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: IdContext) {
  try {
    const user = await requireUser();
    return ok(await getInvoice(user, (await ctx.params).id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/invoices/:id: body { version, clientId?, issueDate?, dueDate?, taxBp?, memo?, lines? }. Drafts only. */
export async function PATCH(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok(await updateInvoice(user, (await ctx.params).id, await readJson(request, JSON_LIMIT)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/invoices/:id: drafts only. */
export async function DELETE(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    await deleteInvoice(user, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
