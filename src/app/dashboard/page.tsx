import type { Metadata } from "next";
import { PageIntro, StatGrid, StatTile } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getInvoiceSummary } from "@/lib/invoices";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Placeholder until issue 9.5 builds the invoice list and editor: the numbers come straight from the data layer. */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const summary = await getInvoiceSummary(user);
  return (
    <>
      <PageIntro section="Dashboard" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}.`} />
      <StatGrid>
        <StatTile value={formatCents(summary.outstandingCents)} label="Outstanding" tone="accent" />
        <StatTile value={formatCents(summary.overdueCents)} label="Overdue" />
        <StatTile value={formatCents(summary.paidThisMonthCents)} label="Paid this month" />
      </StatGrid>
    </>
  );
}
