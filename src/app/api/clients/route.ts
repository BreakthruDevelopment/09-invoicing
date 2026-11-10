import { ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { createClient, listClients } from "@/lib/clients";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";

export const dynamic = "force-dynamic";

/** GET /api/clients[?archived=1]: the caller's clients. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const includeArchived = new URL(request.url).searchParams.get("archived") === "1";
    return ok({ clients: await listClients(user, { includeArchived }) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/clients: body { name, email?, address?, hourlyRateCents? } */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok({ client: await createClient(user, await readJson(request, JSON_LIMIT)) }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
