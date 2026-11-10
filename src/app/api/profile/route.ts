import { ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { getProfile, updateProfile } from "@/lib/business-profile";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { JSON_LIMIT } from "@/lib/invoice-schemas";

export const dynamic = "force-dynamic";

/** GET /api/profile: the caller's business profile (created with defaults on first visit). */
export async function GET() {
  try {
    return ok({ profile: await getProfile(await requireUser()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/profile: body { name, address, contactEmail, timeZone, defaultTermsDays } */
export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return ok({ profile: await updateProfile(user, await readJson(request, JSON_LIMIT)) });
  } catch (err) {
    return errorResponse(err);
  }
}
