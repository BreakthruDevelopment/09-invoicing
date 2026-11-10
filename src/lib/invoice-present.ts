import "server-only";
import type { ClientInvoice } from "@/components/invoicing/types";
import type { InvoiceDetail } from "@/lib/invoices";

/** The invoice page's view of a detail row. Drops the share-token hash (already absent) and dates become strings. */
export function presentInvoice(detail: InvoiceDetail): ClientInvoice {
  const row = detail.invoice;
  const balanceCents = row.status === "sent" ? row.totalCents - row.paidCents : 0;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    overdue: row.overdue,
    number: row.number,
    clientId: row.clientId,
    clientName: detail.clientName,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    taxBp: row.taxBp,
    memo: row.memo,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    balanceCents,
    hasShareLink: row.hasShareLink,
    voidReason: row.voidReason,
    mailtoEmail: row.clientSnapshot?.email ?? null,
    lines: detail.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      description: line.description,
      quantityX100: line.quantityX100,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      source: line.source,
    })),
    payments: detail.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amountCents: payment.amountCents,
      note: payment.note,
      flag: payment.flag,
      receivedAt: payment.receivedAt.toISOString(),
    })),
  };
}
