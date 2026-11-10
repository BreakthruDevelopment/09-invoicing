import Link from "next/link";
import type { Metadata } from "next";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";
import { InvoiceStatusBadge } from "@/components/invoicing/invoice-status";
import type { InvoiceStatus } from "@/components/invoicing/types";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listClients } from "@/lib/clients";
import { getInvoiceSummary, listInvoices, type InvoiceListItem } from "@/lib/invoices";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const STATUS_FILTERS = ["", "draft", "sent", "overdue", "paid", "void"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUserOrRedirect();
  const params = await searchParams;
  const status = first(params.status);
  const clientId = first(params.clientId);
  const query = first(params.q).trim().toLowerCase();
  const view = first(params.view) === "cards" ? "cards" : "table";
  const statusFilter = (STATUS_FILTERS as readonly string[]).includes(status) ? status : "";
  const clientFilter = UUID.test(clientId) ? clientId : "";

  const [summary, invoices, clients] = await Promise.all([
    getInvoiceSummary(user),
    listInvoices(user, {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(clientFilter ? { clientId: clientFilter } : {}),
      limit: 200,
    }),
    listClients(user, { includeArchived: true }),
  ]);

  const shown = query
    ? invoices.filter((invoice) => {
        const number = (invoice.number ?? "draft").toLowerCase();
        const name = (invoice.clientName ?? "").toLowerCase();
        return number.includes(query) || name.includes(query);
      })
    : invoices;

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
    { key: "client", header: "Client", cell: (invoice) => invoice.clientName ?? "—" },
    {
      key: "status",
      header: "Status",
      cell: (invoice) => <InvoiceStatusBadge status={invoice.status as InvoiceStatus} overdue={invoice.overdue} />,
    },
    { key: "issued", header: "Issued", cell: (invoice) => invoice.issueDate },
    { key: "due", header: "Due", cell: (invoice) => invoice.dueDate },
    { key: "total", header: "Total", cell: (invoice) => formatCents(invoice.totalCents) },
  ];

  return (
    <>
      <PageIntro
        section="Invoices"
        title="Invoices"
        description={`Signed in as ${user.email}. Outstanding, overdue and paid this month are your totals, not the filter.`}
        actions={
          <Link href="/invoices/new" className={buttonPrimary}>
            New invoice
          </Link>
        }
      />
      <StatGrid>
        <StatTile value={formatCents(summary.outstandingCents)} label="Outstanding" tone="accent" />
        <StatTile value={formatCents(summary.overdueCents)} label="Overdue" tone={summary.overdueCents > 0 ? "blocked" : "default"} />
        <StatTile value={formatCents(summary.paidThisMonthCents)} label="Paid this month" tone="live" />
        <StatTile value={summary.counts.draft ?? 0} label="Drafts" />
      </StatGrid>
      <FilterBar
        label="Filter invoices"
        search={{ value: first(params.q), placeholder: "Number or client" }}
        filters={[
          {
            name: "status",
            label: "Status",
            value: statusFilter,
            options: [
              { value: "", label: "All statuses" },
              { value: "draft", label: "Draft" },
              { value: "sent", label: "Sent" },
              { value: "overdue", label: "Overdue" },
              { value: "paid", label: "Paid" },
              { value: "void", label: "Void" },
            ],
          },
          {
            name: "clientId",
            label: "Client",
            value: clientFilter,
            options: [
              { value: "", label: "All clients" },
              ...clients.map((client) => ({ value: client.id, label: client.archivedAt ? `${client.name} (archived)` : client.name })),
            ],
          },
        ]}
        view={{ value: view }}
      />
      <Panel title="All invoices" count={shown.length}>
        <DataList
          caption="Invoices"
          rows={shown}
          rowKey={(invoice) => invoice.id}
          columns={columns}
          view={view}
          empty={invoices.length === 0 ? "No invoices yet." : "No invoices match these filters."}
        />
      </Panel>
    </>
  );
}
