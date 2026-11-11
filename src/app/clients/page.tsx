import Link from "next/link";
import type { Metadata } from "next";
import { type Column, DataList, FilterBar, PageIntro, Panel } from "@/components/ui";
import { ClientForm } from "@/components/invoicing/client-form";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listClients, type ClientView } from "@/lib/clients";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUserOrRedirect();
  const params = await searchParams;
  const show = first(params.show);
  const includeArchived = show === "archived" || show === "all";
  const clients = await listClients(user, { includeArchived });
  const shown = show === "archived" ? clients.filter((client) => client.archivedAt) : clients;

  const columns: Column<ClientView>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (client) => (
        <Link href={`/clients/${client.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
          {client.name}
        </Link>
      ),
    },
    { key: "email", header: "Email", className: "break-all", cell: (client) => client.email ?? "—" },
    { key: "rate", header: "Hourly rate", cell: (client) => formatCents(client.hourlyRateCents) },
    { key: "state", header: "State", cell: (client) => (client.archivedAt ? "Archived" : "Active") },
  ];

  return (
    <>
      <PageIntro section="Clients" title="Clients" description="A client’s hourly rate is what Draft from notes uses for hours." />
      <FilterBar
        label="Filter clients"
        filters={[
          {
            name: "show",
            label: "Show",
            value: show === "archived" || show === "all" ? show : "",
            options: [
              { value: "", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "Active and archived" },
            ],
          },
        ]}
      />
      <Panel title={show === "archived" ? "Archived clients" : "Clients"} count={shown.length}>
        <DataList caption="Clients" rows={shown} rowKey={(client) => client.id} columns={columns} empty="No clients yet." />
      </Panel>
      <Panel title="New client">
        <ClientForm />
      </Panel>
    </>
  );
}
