import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type Column, DataList, PageIntro, Panel } from "@/components/ui";
import { DemoBanner } from "@/components/invoicing/demo-banner";
import { InvoiceStatusBadge } from "@/components/invoicing/invoice-status";
import { KIND_LABEL } from "@/components/invoicing/labels";
import { MoneyRows } from "@/components/invoicing/money-rows";
import { PayButton } from "@/components/invoicing/pay-button";
import { PaymentPoll } from "@/components/invoicing/payment-poll";
import type { InvoiceStatus, LineKind } from "@/components/invoicing/types";
import { formatQuantity } from "@/lib/form-money";
import { formatCents } from "@/lib/money";
import { paymentsMode } from "@/lib/payments";
import { getPublicInvoice } from "@/lib/share";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function PublicInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const invoice = await getPublicInvoice(token);
  if (!invoice) notFound();
  const mode = paymentsMode();
  const payment = first(query.payment);
  const rows = invoice.lines.map((line, index) => ({ ...line, index }));
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "description", header: "Description", primary: true, cell: (line) => <span className="break-words">{line.description}</span> },
    { key: "kind", header: "Kind", cell: (line) => KIND_LABEL[line.kind as LineKind] ?? line.kind },
    { key: "qty", header: "Qty", cell: (line) => formatQuantity(line.quantityX100) },
    { key: "price", header: "Price", cell: (line) => formatCents(line.unitPriceCents) },
    { key: "amount", header: "Amount", cell: (line) => formatCents(line.amountCents) },
  ];

  return (
    <>
      <PageIntro
        section={invoice.businessName || "Invoice"}
        title={invoice.number}
        description={invoice.clientName ? `For ${invoice.clientName}.` : undefined}
      />
      {mode === "demo" && <DemoBanner compact />}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <InvoiceStatusBadge status={invoice.status as InvoiceStatus} overdue={invoice.overdue} />
        <p className="text-sm">
          <span className="text-muted">Due </span>
          <time dateTime={invoice.dueDate}>{invoice.dueDate}</time>
        </p>
      </div>
      {payment === "cancelled" && invoice.status === "sent" && (
        <p role="status" className="mb-4 text-sm font-medium">
          Payment cancelled. This invoice is still unpaid.
        </p>
      )}
      {payment === "processing" && invoice.status === "sent" && (
        <div className="mb-4">
          <PaymentPoll token={token} />
        </div>
      )}
      <Panel title="Lines">
        <DataList caption="Invoice lines" rows={rows} rowKey={(line) => String(line.index)} columns={columns} empty="No lines." />
        <div className="mt-4 max-w-sm">
          <MoneyRows
            subtotalCents={invoice.subtotalCents}
            taxBp={invoice.taxBp}
            taxCents={invoice.taxCents}
            totalCents={invoice.totalCents}
            paidCents={invoice.paidCents}
            balanceCents={invoice.balanceCents}
          />
        </div>
        {invoice.memo && <p className="mt-4 text-sm break-words">{invoice.memo}</p>}
      </Panel>
      {invoice.status === "sent" && invoice.balanceCents > 0 && (
        <Panel title="Pay">
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {mode === "demo" ? "Demo payment, no money moves." : "Pay the balance by card. This page stays unpaid until the payment is confirmed."}
            </p>
            <PayButton token={token} mode={mode} />
          </div>
        </Panel>
      )}
      {invoice.status === "paid" && <p className="text-sm font-medium text-success">Paid. Thank you.</p>}
      {invoice.status === "void" && <p className="text-sm text-muted">This invoice was voided and can’t be paid.</p>}
    </>
  );
}
