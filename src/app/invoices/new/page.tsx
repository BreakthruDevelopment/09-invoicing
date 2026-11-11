import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { NewInvoiceForm } from "@/components/invoicing/new-invoice-form";
import type { ClientOption } from "@/components/invoicing/types";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getProfile } from "@/lib/business-profile";
import { listClients } from "@/lib/clients";
import { addDays, todayIn } from "@/lib/invoice-common";

export const metadata: Metadata = { title: "New invoice" };
export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const user = await requireUserOrRedirect();
  const [profile, clients] = await Promise.all([getProfile(user), listClients(user)]);
  const issueDate = todayIn(profile.timeZone);
  const dueDate = addDays(issueDate, profile.defaultTermsDays);
  const options: ClientOption[] = clients.map((client) => ({
    id: client.id,
    name: client.name,
    email: client.email,
    archived: client.archivedAt !== null,
  }));

  return (
    <>
      <PageIntro section="Invoices" title="New invoice" description="Start a draft. Lines and totals are on the next screen." />
      <Panel title="Draft">
        <NewInvoiceForm clients={options} issueDate={issueDate} dueDate={dueDate} />
      </Panel>
    </>
  );
}
