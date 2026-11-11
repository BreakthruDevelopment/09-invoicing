"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actionMessage } from "@/lib/action-message";
import { updateProfile } from "@/lib/business-profile";
import { BadRequestError } from "@/lib/errors";

export type FormState = { error: string; saved?: boolean };

export async function saveProfile(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const user = await requireUser();
    const terms = Number(String(form.get("defaultTermsDays") ?? "").trim());
    if (!Number.isInteger(terms)) throw new BadRequestError("Default terms must be a whole number of days.");
    await updateProfile(user, {
      name: String(form.get("name") ?? ""),
      address: String(form.get("address") ?? ""),
      contactEmail: String(form.get("contactEmail") ?? ""),
      timeZone: String(form.get("timeZone") ?? ""),
      defaultTermsDays: terms,
    });
    revalidatePath("/settings");
    return { error: "", saved: true };
  } catch (err) {
    unstable_rethrow(err);
    return { error: actionMessage(err) };
  }
}
