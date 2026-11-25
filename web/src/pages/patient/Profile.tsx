import { IconChartLine, IconPencil, IconPlus } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { HealthProfile, HealthProfileInput, Lifestyle, ProfileItem } from "@/api/types";
import { staleProfile, usePharmacies, useProfile, useSaveProfile } from "@/data";
import { ageFrom } from "@/lib/format";
import { uuid } from "@/lib/ids";
import { Button, ButtonLink, Combobox, ConfirmDialog, DescriptionList, DiffMergeDialog, Field, FieldGroup, Input, NumberField, PageBody, PageHeader, RadioRows, Section, StatusTag, TextLink, toast } from "@/ui";

import { ActionError, Gate, useFmt } from "./shared";

type ListKey = "conditions" | "allergies" | "family_history" | "medications";
type Patch = Partial<HealthProfileInput>;
/** Saves one section on top of the newest profile; asks when that section changed somewhere else meanwhile. */
type Save = (key: string, label: string, patch: Patch, describe: (p: Patch) => string, done: () => void) => void;

export default function Profile() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const query = useProfile();
  return (
    <PageBody width="read">
      <PageHeader
        title={t("profile.title")}
        lede={t("profile.lede")}
        actions={
          <ButtonLink to="/app/profile/measurements" icon={<IconChartLine aria-hidden />}>
            {t("measure.title")}
          </ButtonLink>
        }
        meta={query.data ? <span>{t("profile.updated", { date: f.dateTime(query.data.updated_at) })}</span> : undefined}
      />
      <Gate query={query} rows={8}>
        {(profile) => <Sections profile={profile} />}
      </Gate>
    </PageBody>
  );
}

function Sections({ profile }: { profile: HealthProfile }) {
  const { t } = useTranslation("patient");
  const mutation = useSaveProfile();
  const [failed, setFailed] = useState<{ key: string; error: unknown } | null>(null);
  const [conflict, setConflict] = useState<{ key: string; label: string; patch: Patch; describe: (p: Patch) => string; current: HealthProfile; done: () => void } | null>(null);

  const run = (base: HealthProfile, key: string, label: string, patch: Patch, describe: (p: Patch) => string, done: () => void) => {
    const { updated_at: _u, ...rest } = base;
    setFailed(null);
    mutation.mutate(
      { ...rest, ...patch },
      {
        onSuccess: () => {
          setConflict(null);
          toast.ok(t("profile.saved"));
          done();
        },
        onError: (e) => {
          const current = staleProfile(e);
          // Someone changed another section: save again on the newer version without asking.
          const same = current && Object.keys(patch).every((k) => JSON.stringify(current[k as keyof HealthProfile]) === JSON.stringify(base[k as keyof HealthProfile]));
          if (current && same) run(current, key, label, patch, describe, done);
          else if (current) setConflict({ key, label, patch, describe, current, done });
          else setFailed({ key, error: e });
        },
      },
    );
  };
  const save: Save = (key, label, patch, describe, done) => run(profile, key, label, patch, describe, done);
  const common = { profile, save, saving: mutation.isPending };
  const errorOf = (key: string) => (failed?.key === key ? <ActionError error={failed.error} className="mt-3" title={t("profile.saveFailed")} /> : null);

  return (
    <>
      <Basics {...common} error={errorOf("basics")} />
      <Items {...common} list="conditions" error={errorOf("conditions")} />
      <Items {...common} list="allergies" error={errorOf("allergies")} />
      <Items {...common} list="medications" error={errorOf("medications")} note={<TextLink to="/app/medications">{t("profile.toMeds")}</TextLink>} />
      <Items {...common} list="family_history" error={errorOf("family_history")} />
      <LifestyleSection {...common} error={errorOf("lifestyle")} />
      <PharmacySection {...common} error={errorOf("pharmacy")} />
      {conflict && (
        <DiffMergeDialog
          open
          onOpenChange={(o) => !o && setConflict(null)}
          fields={[{ key: conflict.key, label: conflict.label, mine: conflict.describe(conflict.patch), theirs: conflict.describe(Object.fromEntries(Object.keys(conflict.patch).map((k) => [k, conflict.current[k as keyof HealthProfile]])) as Patch) }]}
          theirsLabel={t("profile.theirs")}
          busy={mutation.isPending}
          onMerge={(choice) => {
            if (choice[conflict.key] === "mine") run(conflict.current, conflict.key, conflict.label, conflict.patch, conflict.describe, conflict.done);
            else {
              setConflict(null);
              conflict.done();
            }
          }}
        />
      )}
    </>
  );
}

interface SectionProps {
  profile: HealthProfile;
  save: Save;
  saving: boolean;
  error: ReactNode;
}

function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  const { t } = useTranslation("patient");
  return (
    <Button size="sm" icon={<IconPencil aria-hidden />} onClick={onClick} aria-label={t("profile.editSection", { name: label })}>
      {t("sum.edit")}
    </Button>
  );
}
function FormButtons({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  const { t } = useTranslation("patient");
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" loading={saving}>
        {t("common.save")}
      </Button>
      <Button onClick={onCancel}>{t("common.cancel")}</Button>
    </div>
  );
}

const SEXES = ["female", "male", "other"] as const;

function Basics({ profile, save, saving, error }: SectionProps) {
  const { t } = useTranslation("patient");
  const [edit, setEdit] = useState<{ display_name: string; birth_year: number | null; sex: HealthProfile["sex"]; height_cm: number | null } | null>(null);
  const label = t("profile.basics");
  const age = ageFrom(profile.birth_year);
  const year = new Date().getFullYear();
  const badName = edit && (edit.display_name.trim() === "" || [...edit.display_name.trim()].length > 40);
  const badYear = edit && edit.birth_year !== null && (edit.birth_year < 1900 || edit.birth_year > year);
  const badHeight = edit && edit.height_cm !== null && (edit.height_cm < 30 || edit.height_cm > 260);
  return (
    <Section title={label} actions={edit ? undefined : <EditButton label={label} onClick={() => setEdit({ display_name: profile.display_name, birth_year: profile.birth_year, sex: profile.sex, height_cm: profile.height_cm })} />}>
      {edit ? (
        <form
          className="edit-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (badName || badYear || badHeight) return;
            save("basics", label, { ...edit, display_name: edit.display_name.trim() }, (p) => [p.display_name, p.birth_year, p.sex ? t(`profile.sex_${p.sex}`) : "", p.height_cm ? `${p.height_cm} cm` : ""].filter(Boolean).join(t("common.listSep")), () => setEdit(null));
          }}
        >
          <Field label={t("profile.name")} hint={t("profile.nameHint")} error={badName ? t("profile.nameError") : undefined}>
            <Input value={edit.display_name} maxLength={60} autoComplete="off" onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} />
          </Field>
          <Field label={t("profile.birthYear")} hint={t("profile.birthYearHint")} optional error={badYear ? t("profile.birthYearError", { year }) : undefined}>
            <NumberField className="max-w-40" value={edit.birth_year} onValueChange={(n) => setEdit({ ...edit, birth_year: n })} />
          </Field>
          <FieldGroup label={t("profile.sex")} optional>
            <RadioRows label={t("profile.sex")} value={edit.sex ?? undefined} onValueChange={(v) => setEdit({ ...edit, sex: v as HealthProfile["sex"] })} options={SEXES.map((s) => ({ value: s, label: t(`profile.sex_${s}`) }))} />
          </FieldGroup>
          <Field label={t("profile.height")} optional error={badHeight ? t("profile.heightError") : undefined}>
            <NumberField className="max-w-40" value={edit.height_cm} unit="cm" onValueChange={(n) => setEdit({ ...edit, height_cm: n })} />
          </Field>
          <FormButtons saving={saving} onCancel={() => setEdit(null)} />
          {error}
        </form>
      ) : (
        <DescriptionList
          items={[
            { label: t("profile.name"), value: profile.display_name },
            { label: t("profile.birthYear"), value: profile.birth_year ? t("profile.birthYearValue", { year: profile.birth_year, age }) : null },
            { label: t("profile.sex"), value: profile.sex ? t(`profile.sex_${profile.sex}`) : null },
            { label: t("profile.height"), value: profile.height_cm ? `${profile.height_cm} cm` : null },
          ]}
        />
      )}
    </Section>
  );
}

const EMPTY_ITEM = { name: "", detail: "", since: "" };

/** One list of the record. Clinic entries are shown and locked; the patient's own can be changed. */
function Items({ profile, save, saving, error, list, note }: SectionProps & { list: ListKey; note?: ReactNode }) {
  const { t } = useTranslation("patient");
  const items = profile[list];
  const label = t(`profile.${list}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_ITEM);
  const [tried, setTried] = useState(false);
  const describe = (p: Patch) =>
    ((p[list] as ProfileItem[] | undefined) ?? [])
      .filter((i) => i.status === "active")
      .map((i) => [i.name, i.detail].filter(Boolean).join(" "))
      .join(t("common.listSep"));
  const open = (item: ProfileItem | null) => {
    setTried(false);
    setForm(item ? { name: item.name, detail: item.detail ?? "", since: item.since ?? "" } : EMPTY_ITEM);
    setEditing(item ? item.id : "new");
  };
  const close = () => setEditing(null);
  const nameError = form.name.trim() === "" ? t("profile.itemNameNeeded") : [...form.name.trim()].length > 80 ? t("profile.itemNameLong") : undefined;
  const submit = () => {
    if (nameError) {
      setTried(true);
      return;
    }
    const part = { name: form.name.trim(), detail: form.detail.trim() || null, since: form.since.trim() || null };
    const next: ProfileItem[] = editing === "new" ? [...items, { id: uuid(), ...part, source: "patient", status: "active" }] : items.map((i) => (i.id === editing ? { ...i, ...part } : i));
    save(list, label, { [list]: next }, describe, close);
  };
  const editor = (
    <form
      className="edit-box my-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label={t(`profile.${list}_name`)} error={tried ? nameError : undefined}>
        <Input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t(`profile.${list}_detail`)} optional>
        <Input value={form.detail} maxLength={300} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
      </Field>
      <Field label={t("profile.since")} hint={t("profile.sinceHint")} optional>
        <Input className="max-w-48" value={form.since} maxLength={20} onChange={(e) => setForm({ ...form, since: e.target.value })} />
      </Field>
      <FormButtons saving={saving} onCancel={close} />
      {error}
    </form>
  );
  const active = items.filter((i) => i.status === "active");
  const past = items.filter((i) => i.status === "inactive");
  return (
    <Section
      title={label}
      actions={
        editing === null ? (
          <Button size="sm" icon={<IconPlus aria-hidden />} onClick={() => open(null)} aria-label={t("profile.addTo", { name: label })}>
            {t("profile.add")}
          </Button>
        ) : undefined
      }
    >
      {note && <p className="mb-2 text-sm">{note}</p>}
      {items.length === 0 && editing !== "new" && <p className="text-fg-3">{t(`profile.${list}_none`)}</p>}
      <ul>
        {[...active, ...past].map((i) =>
          editing === i.id ? (
            <li key={i.id}>{editor}</li>
          ) : (
            <li key={i.id} className="item-row">
              <span className="grow">
                <span className={i.status === "inactive" ? "text-fg-3 line-through" : "font-medium"}>{i.name}</span>
                {(i.detail || i.since || i.status === "inactive") && (
                  <span className="block text-sm text-fg-2">{[i.detail, i.since ? t("profile.sinceValue", { since: i.since }) : null, i.status === "inactive" ? t("profile.inactive") : null].filter(Boolean).join(t("common.sep"))}</span>
                )}
              </span>
              <StatusTag family="source" status={i.source} />
              {i.source === "patient" && editing === null && (
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" variant="quiet" onClick={() => open(i)} aria-label={t("profile.editItem", { name: i.name })}>
                    {t("sum.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={saving}
                    onClick={() => save(list, label, { [list]: items.map((x) => (x.id === i.id ? { ...x, status: x.status === "active" ? "inactive" : "active" } : x)) }, describe, close)}
                    aria-label={t(i.status === "active" ? "profile.stopItem" : "profile.resumeItem", { name: i.name })}
                  >
                    {t(i.status === "active" ? "profile.stop" : "profile.resume")}
                  </Button>
                  <RemoveItem item={i} onConfirm={() => save(list, label, { [list]: items.filter((x) => x.id !== i.id) }, describe, close)} />
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {editing === "new" && editor}
      {editing === null && error}
      {items.some((i) => i.source === "clinic") && <p className="mt-2 text-sm text-fg-2">{t("profile.clinicNote")}</p>}
    </Section>
  );
}

function RemoveItem({ item, onConfirm }: { item: ProfileItem; onConfirm: () => void }) {
  const { t } = useTranslation("patient");
  const [open, setOpen] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="quiet" aria-label={t("profile.removeItem", { name: item.name })}>
          {t("profile.remove")}
        </Button>
      }
      title={t("profile.removeTitle", { name: item.name })}
      description={t("profile.removeBody")}
      confirmLabel={t("profile.remove")}
      destructive
      onConfirm={onConfirm}
    />
  );
}

const LIFE = ["smoking", "alcohol", "exercise"] as const;

function LifestyleSection({ profile, save, saving, error }: SectionProps) {
  const { t } = useTranslation("patient");
  const [edit, setEdit] = useState<Lifestyle | null>(null);
  const label = t("profile.lifestyle");
  return (
    <Section title={label} actions={edit ? undefined : <EditButton label={label} onClick={() => setEdit(profile.lifestyle)} />}>
      {edit ? (
        <form
          className="edit-box"
          onSubmit={(e) => {
            e.preventDefault();
            const clean = Object.fromEntries(LIFE.map((k) => [k, edit[k]?.trim() || null])) as unknown as Lifestyle;
            save("lifestyle", label, { lifestyle: clean }, (p) => LIFE.map((k) => p.lifestyle?.[k]).filter(Boolean).join(t("common.listSep")), () => setEdit(null));
          }}
        >
          {LIFE.map((k) => (
            <Field key={k} label={t(`profile.${k}`)} hint={t(`profile.${k}Hint`)} optional>
              <Input value={edit[k] ?? ""} maxLength={80} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
            </Field>
          ))}
          <FormButtons saving={saving} onCancel={() => setEdit(null)} />
          {error}
        </form>
      ) : (
        <DescriptionList items={LIFE.map((k) => ({ label: t(`profile.${k}`), value: profile.lifestyle[k] }))} />
      )}
    </Section>
  );
}

function PharmacySection({ profile, save, saving, error }: SectionProps) {
  const { t } = useTranslation("patient");
  const pharmacies = usePharmacies();
  const label = t("profile.pharmacy");
  const current = pharmacies.data?.find((p) => p.id === profile.preferred_pharmacy_id);
  return (
    <Section title={label}>
      <p className="mb-3 text-fg-2">{t("profile.pharmacyBody")}</p>
      <div className="max-w-md">
        <Combobox
          label={label}
          value={profile.preferred_pharmacy_id}
          placeholder={saving ? t("profile.saving") : t("profile.pharmacyNone")}
          searchPlaceholder={t("pharm.search")}
          options={(pharmacies.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: `${p.district} ${p.address}`, keywords: [p.district, p.address] }))}
          onValueChange={(id) => save("pharmacy", label, { preferred_pharmacy_id: id }, (p) => pharmacies.data?.find((x) => x.id === p.preferred_pharmacy_id)?.name ?? "", () => undefined)}
        />
      </div>
      {current && <p className="mt-2 text-sm text-fg-2">{t("pharm.hours", { hours: current.hours })}</p>}
      {error}
    </Section>
  );
}
