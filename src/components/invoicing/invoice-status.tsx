import { StatusBadge } from "@/components/ui";
import type { InvoiceStatus } from "./types";

/** Draft, sent, paid, void, and overdue. Overdue is computed by the server and wins over "sent". */
export function InvoiceStatusBadge({ status, overdue }: { status: InvoiceStatus; overdue?: boolean }) {
  if (overdue) return <StatusBadge status="blocked" label="Overdue" />;
  if (status === "paid") return <StatusBadge status="live" label="Paid" />;
  if (status === "sent") return <StatusBadge status="building" label="Sent" />;
  if (status === "void") return <StatusBadge status="not-started" label="Void" />;
  return <StatusBadge status="not-started" label="Draft" />;
}
