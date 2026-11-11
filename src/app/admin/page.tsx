import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { LoadDemoButton } from "@/components/invoicing/load-demo-button";
import { getAdminStats } from "@/lib/admin-stats";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const stats = await getAdminStats(admin);
  const users = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(100);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (user) => user.name },
    { key: "email", header: "Email", className: "break-all", cell: (user) => <span className="break-all">{user.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (user) => (user.role === "admin" ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (user) => user.createdAt.toISOString().slice(0, 10),
    },
  ];

  const invoiceCount = Object.values(stats.invoicesByStatus).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <PageIntro
        section="Admin"
        title="Counts"
        description="Users, invoices, payments and today’s AI calls. No client names, amounts or notes."
      />
      <StatGrid>
        <StatTile value={stats.users} label="Users" tone="accent" />
        <StatTile value={invoiceCount} label="Invoices" />
        <StatTile value={stats.ai.callsToday} label="AI calls today" />
        <StatTile value={stats.ai.dailyCap} label="AI daily cap" />
      </StatGrid>
      <Panel title="Invoices by status">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {Object.entries(stats.invoicesByStatus).map(([status, count]) => (
            <div key={status} className="rounded-card bg-background px-3 py-3">
              <dt className="capitalize text-muted">{status}</dt>
              <dd className="font-display text-3xl font-semibold">{count}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title="Payments by method">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {Object.entries(stats.paymentsByMethod).map(([method, count]) => (
            <div key={method} className="rounded-card bg-background px-3 py-3">
              <dt className="capitalize text-muted">{method}</dt>
              <dd className="font-display text-3xl font-semibold">{count}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title="Demo workspace">
        <LoadDemoButton />
      </Panel>
      <Panel title="Accounts" count={users.length} collapsible defaultOpen={false} closedLabel="Show accounts">
        <DataList caption="Users" rows={users} rowKey={(user) => user.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}
