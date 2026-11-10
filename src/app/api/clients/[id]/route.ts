import { type IdContext, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { archiveClient, getClient, updateClient } from "@/lib/clients";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: IdContext) {
  try {
    const user = await requireUser();
    return ok({ client: await getClient(user, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/clients/:id: any of { name, email, address, hourlyRateCents } */
export async function PATCH(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok({ client: await updateClient(user, (await ctx.params).id, await readJson(request, JSON_LIMIT)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/clients/:id: archives the client; its invoices are kept. */
export async function DELETE(request: Request, ctx: IdContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    await archiveClient(user, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
