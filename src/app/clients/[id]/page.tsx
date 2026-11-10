import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type Column, DataList, PageIntro, Panel } from "@/components/ui";
import { ClientForm } from "@/components/invoicing/client-form";
import { InvoiceStatusBadge } from "@/components/invoicing/invoice-status";
import type { InvoiceStatus } from "@/components/invoicing/types";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getClient } from "@/lib/clients";
import { NotFoundError } from "@/lib/errors";
import { listInvoices, type InvoiceListItem } from "@/lib/invoices";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Client" };
export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  let client;
  try {
    client = await getClient(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const invoices = await listInvoices(user, { clientId: client.id, limit: 100 });
  const columns: Column<InvoiceListItem>[] = [
    {
      key: "number",
      header: "Invoice",
      primary: true,
      cell: (invoice) => (
        <Link href={`/invoices/${invoice.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
          {invoice.number ?? "Draft"}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (invoice) => <InvoiceStatusBadge status={invoice.status as InvoiceStatus} overdue={invoice.overdue} />,
    },
    { key: "due", header: "Due", cell: (invoice) => invoice.dueDate },
    { key: "total", header: "Total", cell: (invoice) => formatCents(invoice.totalCents) },
  ];

  return (
    <>
      <PageIntro section="Clients" title={client.name} description={client.email ?? "No email on file."} />
      <Panel title="Details">
        <ClientForm
          id={client.id}
          client={{
            name: client.name,
            email: client.email,
            address: client.address,
            hourlyRateCents: client.hourlyRateCents,
            archived: client.archivedAt !== null,
          }}
        />
      </Panel>
      <Panel title="Invoices" count={invoices.length}>
        <DataList caption="Invoices for this client" rows={invoices} rowKey={(invoice) => invoice.id} columns={columns} empty="No invoices for this client yet." />
      </Panel>
    </>
  );
}
