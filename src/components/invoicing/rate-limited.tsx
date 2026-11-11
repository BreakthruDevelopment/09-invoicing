import { PageIntro } from "@/components/ui";

/** Shown in place of a public invoice page when the per-IP limit is hit. Carries no invoice data. */
export function RateLimited() {
  return (
    <PageIntro
      section="Invoice"
      title="Too many requests"
      description="Please wait a minute and reload this page."
    />
  );
}
