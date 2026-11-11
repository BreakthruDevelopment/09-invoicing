import { formatCents } from "@/lib/money";
import { formatTaxLabel } from "@/lib/form-money";

/** Prints totals the server already computed. This component does no arithmetic on the amounts. */
export function MoneyRows({
  subtotalCents,
  taxBp,
  taxCents,
  totalCents,
  paidCents = 0,
  balanceCents = 0,
}: {
  subtotalCents: number;
  taxBp: number;
  taxCents: number;
  totalCents: number;
  paidCents?: number;
  balanceCents?: number;
}) {
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-muted">Subtotal</dt>
        <dd className="font-medium tabular-nums">{formatCents(subtotalCents)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-muted">Tax ({formatTaxLabel(taxBp)})</dt>
        <dd className="font-medium tabular-nums">{formatCents(taxCents)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatCents(totalCents)}</dd>
      </div>
      {paidCents > 0 && (
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted">Paid</dt>
          <dd className="font-medium tabular-nums">{formatCents(paidCents)}</dd>
        </div>
      )}
      {balanceCents > 0 && (
        <div className="flex items-baseline justify-between gap-4 font-semibold">
          <dt>Balance due</dt>
          <dd className="tabular-nums">{formatCents(balanceCents)}</dd>
        </div>
      )}
    </dl>
  );
}
