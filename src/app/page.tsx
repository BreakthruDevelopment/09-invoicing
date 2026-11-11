import Link from "next/link";
import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { DemoBanner } from "@/components/invoicing/demo-banner";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Invoicing" };

const points = [
  { title: "Clients and drafts", body: "Keep a client list with an hourly rate. Draft an invoice, then send it. A sent invoice is frozen; void and duplicate it to change one." },
  { title: "Draft from notes", body: "Paste a week of project notes. Each suggested line shows the evidence it came from. Nothing is added until you check the lines." },
  { title: "A link the client opens", body: "Send is a share link, not an email from us. Your client opens it on a phone, then pays with the demo payment. No card is charged." },
];

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <>
      <PageIntro
        section="Invoicing"
        title="Invoices that get paid."
        description="Keep clients, turn project notes into line items, and send a link your client can open on a phone."
        actions={
          user ? (
            <Link href="/invoices" className={buttonPrimary}>
              Your invoices
            </Link>
          ) : (
            <Link href="/sign-in" className={buttonPrimary}>
              Sign in
            </Link>
          )
        }
      />
      <DemoBanner />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {points.map((point) => (
          <Panel key={point.title} title={point.title}>
            <p className="text-muted">{point.body}</p>
          </Panel>
        ))}
      </div>
      {!user && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted">New here?</p>
          <Link href="/sign-in" className={buttonSecondary}>
            Create an account
          </Link>
        </div>
      )}
    </>
  );
}
