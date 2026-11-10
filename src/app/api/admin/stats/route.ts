import { ok } from "@/lib/api";
import { getAdminStats } from "@/lib/admin-stats";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats: counts only. */
export async function GET() {
  try {
    return ok({ stats: await getAdminStats(await requireRole("admin")) });
  } catch (err) {
    return errorResponse(err);
  }
}
