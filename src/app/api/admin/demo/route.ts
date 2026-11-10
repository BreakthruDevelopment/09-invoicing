import { ok } from "@/lib/api";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/demo (admin): replace the two demo owners' data with the sample workspace (4 clients, 8 invoices
 * in every state, the seeded notes). Bodyless: callers can't choose CLI credentials. 1 per minute and 20 per UTC
 * day, app-wide. Answers counts only. A demo email held by an unrelated account is a 409.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireRole("admin");
    return ok(await loadDemoWorkspace(actor, { mode: "admin" }, { reserve: true }));
  } catch (err) {
    return errorResponse(err);
  }
}
