import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

/** Older links land here. The invoice list is the home for a signed-in owner. */
export default async function DashboardPage() {
  await requireUserOrRedirect();
  redirect("/invoices");
}
