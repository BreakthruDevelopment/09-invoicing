import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createItem, listItems } from "@/lib/items";

export const dynamic = "force-dynamic";

/** GET /api/items — the caller's items (all items for admins). */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ items: await listItems(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/items — body: { title: string, body?: string } */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request); // cookie-authenticated mutation: our own Origin only
    const user = await requireUser();
    const item = await createItem(user, await readJson(request));
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
