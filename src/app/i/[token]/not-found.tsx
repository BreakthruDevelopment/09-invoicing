import { PageIntro } from "@/components/ui";

export default function PublicInvoiceNotFound() {
  return (
    <PageIntro
      section="Invoice"
      title="This link isn’t available"
      description="The invoice may be a draft, or the link was rotated. Ask the sender for a new one."
    />
  );
}
