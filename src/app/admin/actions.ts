"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { actionMessage } from "@/lib/action-message";
import { loadDemoWorkspace } from "@/lib/demo-workspace";

export type DemoState =
  | { ok: true; users: number; clients: number; invoices: number; notes: number }
  | { ok: false; error: string };

/** Replace the demo businesses. The answer is counts only: no client names, amounts or notes. */
export async function loadDemoAction(): Promise<DemoState> {
  try {
    const actor = await requireRole("admin");
    const result = await loadDemoWorkspace(actor, { mode: "admin" }, { reserve: true });
    revalidatePath("/admin");
    return { ok: true, ...result };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: actionMessage(err) };
  }
}
