"use client";

import { useActionState } from "react";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { saveProfile, type FormState } from "@/app/settings/actions";
import { Alert, SavedNote } from "./feedback";

const empty: FormState = { error: "" };

export function ProfileForm({
  profile,
  timeZones,
}: {
  profile: { name: string; address: string; contactEmail: string; timeZone: string; defaultTermsDays: number };
  timeZones: string[];
}) {
  const [state, action, pending] = useActionState(saveProfile, empty);
  const zones = timeZones.includes(profile.timeZone) ? timeZones : [profile.timeZone, ...timeZones];

  return (
    <form action={action} className="space-y-4">
      <label className={labelClass}>
        <span>Business name</span>
        <input name="name" required maxLength={120} defaultValue={profile.name} disabled={pending} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Address</span>
        <textarea name="address" maxLength={300} rows={3} defaultValue={profile.address} disabled={pending} className={`${inputClass} min-h-24 py-2`} />
      </label>
      <label className={labelClass}>
        <span>Contact email</span>
        <input name="contactEmail" type="email" maxLength={254} defaultValue={profile.contactEmail} disabled={pending} className={inputClass} aria-describedby="email-hint" />
      </label>
      <p id="email-hint" className="text-sm text-muted">
        Printed on invoices. This app does not send mail itself.
      </p>
      <label className={labelClass}>
        <span>Time zone</span>
        <select name="timeZone" defaultValue={profile.timeZone} disabled={pending} className={inputClass}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>Default payment terms (days)</span>
        <input
          name="defaultTermsDays"
          type="number"
          min={0}
          max={90}
          required
          defaultValue={profile.defaultTermsDays}
          disabled={pending}
          className={inputClass}
        />
      </label>
      {state.error && <Alert>{state.error}</Alert>}
      {state.saved && <SavedNote>Saved.</SavedNote>}
      <button type="submit" className={buttonPrimary} disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
