/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
const configuredName = process.env.APP_NAME;
export const APP_TITLE = configuredName && configuredName !== "30 Apps Template" ? configuredName : "Invoicing";

export const APP_DESCRIPTION = "Draft invoices from project notes, send a link, and get paid. Totals are calculated on the server.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `adminOnly` links are hidden for other users; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/invoices", label: "Invoices" },
  { href: "/clients", label: "Clients" },
  { href: "/settings", label: "Settings" },
  { href: "/admin", label: "Admin", adminOnly: true },
];
