import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { ProfileForm } from "@/components/invoicing/profile-form";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getProfile } from "@/lib/business-profile";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London"];
  }
}

export default async function SettingsPage() {
  const user = await requireUserOrRedirect();
  const profile = await getProfile(user);
  return (
    <>
      <PageIntro
        section="Settings"
        title="Business profile"
        description="The name and address printed on invoices. Overdue is judged in this time zone."
      />
      <Panel title="Your business">
        <ProfileForm
          timeZones={timeZones()}
          profile={{
            name: profile.name,
            address: profile.address,
            contactEmail: profile.contactEmail,
            timeZone: profile.timeZone,
            defaultTermsDays: profile.defaultTermsDays,
          }}
        />
      </Panel>
    </>
  );
}
