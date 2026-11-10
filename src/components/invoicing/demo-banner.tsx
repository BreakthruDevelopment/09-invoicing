import { DemoBadge } from "@/components/ui";

/** Shown where a visitor needs to know that payments in this app do not move real money. */
export function DemoBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div className="mb-6 rounded-card border border-border bg-accent-soft px-4 py-3">
      <DemoBadge label="Demo" />
      <p className={compact ? "mt-2 text-sm" : "mt-2 text-sm sm:text-base"}>
        Pay (demo) records a payment without charging a card. No real money moves.
      </p>
    </div>
  );
}
