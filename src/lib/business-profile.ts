import "server-only";
import { eq } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ensureProfile, writeTx } from "@/lib/invoice-common";
import { profileInput } from "@/lib/invoice-schemas";

/** The caller's own business profile (created on first visit). Nobody reads another owner's, admin included. */
export async function getProfile(actor: Actor) {
  assertCan(actor, "create");
  return ensureProfile(db(), actor.id);
}

export async function updateProfile(actor: Actor, raw: unknown) {
  assertCan(actor, "create");
  const input = profileInput.parse(raw);
  return writeTx(actor, async (tx) => {
    await ensureProfile(tx, actor.id);
    const [row] = await tx
      .update(schema.businessProfile)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.businessProfile.ownerId, actor.id))
      .returning();
    return row;
  });
}
