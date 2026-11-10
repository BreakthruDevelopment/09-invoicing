import "server-only";
import { env } from "@/lib/env";
import { type CheckoutInvoice, createStripeCheckout } from "./stripe";
import { paymentsConfig } from "./config";

/** What the spec calls a provider: given a sent invoice and the payer's share token, where to send the payer. */
export interface PaymentProvider {
  name: "demo" | "stripe";
  createCheckout(invoice: CheckoutInvoice & { paidCents: number }, shareToken: string): Promise<{ url: string }>;
}

const appOrigin = () => new URL(env().APP_URL).origin;
const balanceOf = (invoice: { totalCents: number; paidCents: number }) => invoice.totalCents - invoice.paidCents;

/** Sends the payer to our own "Demo payment, no money moves" page. */
export const demoProvider: PaymentProvider = {
  name: "demo",
  async createCheckout(_invoice, shareToken) {
    return { url: `${appOrigin()}/i/${shareToken}/demo-pay` };
  },
};

function stripeProvider(secretKey: string): PaymentProvider {
  return {
    name: "stripe",
    async createCheckout(invoice, shareToken) {
      const { url } = await createStripeCheckout(secretKey, invoice, balanceOf(invoice), shareToken, appOrigin());
      return { url };
    },
  };
}

/** The provider for this process's configuration (see `paymentsConfig`). */
export function selectProvider(): PaymentProvider {
  const config = paymentsConfig();
  return config.mode === "stripe" ? stripeProvider(config.secretKey) : demoProvider;
}
