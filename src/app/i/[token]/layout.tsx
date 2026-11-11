import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PublicInvoiceLayout({ children }: { children: ReactNode }) {
  return children;
}
