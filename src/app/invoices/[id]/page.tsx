import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro } from "@/components/ui";
import { InvoiceScreen } from "@/components/invoicing/invoice-screen";
import type { ClientOption } from "@/components/invoicing/types";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listClients } from "@/lib/clients";
import { NotFoundError } from "@/lib/errors";
import { presentInvoice } from "@/lib/invoice-present";
import { getInvoice } from "@/lib/invoices";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  let detail;
  try {
    detail = await getInvoice(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const clients = await listClients(user, { includeArchived: true });
  const options: ClientOption[] = clients.map((client) => ({
    id: client.id,
    name: client.name,
    email: client.email,
    archived: client.archivedAt !== null,
  }));
  const invoice = presentInvoice(detail);

  return (
    <>
      <PageIntro
        section="Invoices"
        title={invoice.number ?? "Draft invoice"}
        description={invoice.clientName ? `For ${invoice.clientName}.` : "Choose a client, add lines, then save. Totals come back from the server."}
      />
      <InvoiceScreen initial={invoice} clients={options} />
    </>
  );
}
