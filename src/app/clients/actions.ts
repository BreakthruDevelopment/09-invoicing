"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actionMessage } from "@/lib/action-message";
import { archiveClient, createClient, updateClient } from "@/lib/clients";
import { BadRequestError } from "@/lib/errors";
import { parseCents } from "@/lib/form-money";

export type FormState = { error: string; saved?: boolean };

/** Hourly rates are cents, 0 to $1,000.00. The field is dollars. */
function readClient(form: FormData) {
  const rateRaw = String(form.get("hourlyRate") ?? "").trim();
  const hourlyRateCents = rateRaw === "" ? 0 : parseCents(rateRaw, 100_000);
  if (hourlyRateCents === null) throw new BadRequestError("Enter an hourly rate from 0 to 1000.00.");
  return {
    name: String(form.get("name") ?? ""),
    email: String(form.get("email") ?? ""),
    address: String(form.get("address") ?? ""),
    hourlyRateCents,
  };
}

export async function createClientAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const user = await requireUser();
    const row = await createClient(user, readClient(form));
    revalidatePath("/clients");
    redirect(`/clients/${row.id}`);
  } catch (err) {
    unstable_rethrow(err);
    return { error: actionMessage(err) };
  }
}

export async function updateClientAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  try {
    const user = await requireUser();
    await updateClient(user, id, readClient(form));
    revalidatePath("/clients");
    revalidatePath(`/clients/${id}`);
    return { error: "", saved: true };
  } catch (err) {
    unstable_rethrow(err);
    return { error: actionMessage(err) };
  }
}

export async function archiveClientAction(id: string): Promise<FormState> {
  try {
    const user = await requireUser();
    await archiveClient(user, id);
    revalidatePath("/clients");
    revalidatePath(`/clients/${id}`);
    redirect("/clients");
  } catch (err) {
    unstable_rethrow(err);
    return { error: actionMessage(err) };
  }
}
