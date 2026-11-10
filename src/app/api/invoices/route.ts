import { ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";
import { createInvoice, listInvoices } from "@/lib/invoices";

export const dynamic = "force-dynamic";

/** GET /api/invoices[?status=draft|sent|paid|void|overdue&clientId=&limit=] */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return ok({ invoices: await listInvoices(user, Object.fromEntries(new URL(request.url).searchParams)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/invoices: body { clientId?, issueDate?, dueDate?, taxBp?, memo?, lines? }. Totals are computed here. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok(await createInvoice(user, await readJson(request, JSON_LIMIT)), 201);
  } catch (err) {
    return errorResponse(err);
  }
}
