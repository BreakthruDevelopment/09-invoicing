import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro, Panel } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { DemoPayButton } from "@/components/invoicing/demo-pay-button";
import { formatCents } from "@/lib/money";
import { paymentsMode } from "@/lib/payments";
import { getPublicInvoice } from "@/lib/share";

export const metadata: Metadata = { title: "Demo payment" };
export const dynamic = "force-dynamic";

export default async function DemoPayPage({ params }: { params: Promise<{ token: string }> }) {
  if (paymentsMode() !== "demo") notFound();
  const { token } = await params;
  const invoice = await getPublicInvoice(token);
  if (!invoice) notFound();

  return (
    <>
      <PageIntro
        section={invoice.businessName || "Invoice"}
        title="Demo payment, no money moves"
        description={`${invoice.number}${invoice.clientName ? ` for ${invoice.clientName}` : ""}. Confirming records the full balance as a demo payment.`}
      />
      <Panel title={formatCents(invoice.balanceCents > 0 ? invoice.balanceCents : invoice.totalCents)}>
        {invoice.status === "sent" && invoice.balanceCents > 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">No card is charged. This is the demo provider.</p>
            <DemoPayButton token={token} />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              {invoice.status === "paid" ? "This invoice is already paid." : "This invoice can’t be paid."}
            </p>
            <Link href={`/i/${token}`} className={buttonSecondary}>
              Back to the invoice
            </Link>
          </div>
        )}
      </Panel>
    </>
  );
}
