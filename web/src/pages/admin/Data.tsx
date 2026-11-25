import { IconRotateClockwise2 } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useMeta, useResetDemo } from "@/data";
import { Banner, Button, Dialog, Field, Input, NumberField, PageBody, PageHeader, Panel, RuledTable, SkeletonRows, toast } from "@/ui";

import { LoadProblem, Problem } from "../pharmacy/shared/problem";
import { SaveBar, useSettingsForm } from "./lib/useSettingsForm";

const WORD = "RESET";

export default function Data() {
  const { t } = useTranslation("admin");
  const form = useSettingsForm();
  const s = form.value;
  return (
    <PageBody width="wide">
      <PageHeader title={t("data.title")} lede={t("data.lede")} />
      <div className="grid max-w-5xl gap-5">
        <Panel title={t("data.retention")}>
          {form.query.isError && !s ? (
            <LoadProblem error={form.query.error} onRetry={() => void form.query.refetch()} />
          ) : !s ? (
            <SkeletonRows rows={2} />
          ) : (
            <>
              <Field label={t("setting.retention_days")} hint={t("data.retentionHint")} error={form.errorOf("retention_days")} className="max-w-xs">
                <NumberField value={s.retention_days} onValueChange={(v) => form.set("retention_days", v)} min={1} max={365} steppers unit={t("unit.days")} />
              </Field>
              <SaveBar form={form} />
            </>
          )}
        </Panel>
        <Panel title={t("data.kept")}>
          <p className="mb-3 text-fg-2">{t("data.keptLede")}</p>
          <RuledTable
            caption={t("data.kept")}
            head={[t("data.what"), t("data.howLong"), t("data.how")]}
            rows={[
              [t("data.visits"), t("data.byRetention"), t("data.visitsHow")],
              [t("data.guests"), t("data.byRetention"), t("data.guestsHow")],
              [t("data.accounts"), t("data.untilDeleted"), t("data.accountsHow")],
              [t("data.drafts"), t("data.days", { count: 60 }), t("data.auto")],
              [t("data.notifications"), t("data.days", { count: 90 }), t("data.auto")],
              [t("data.sessions"), t("data.untilExpired"), t("data.auto")],
              [t("data.audit"), t("data.forever"), t("data.auditHow")],
              [t("data.usage"), t("data.forever"), t("data.usageHow")],
            ]}
          />
          <p className="mt-3 text-sm text-fg-2">{t("data.source")}</p>
        </Panel>
        <Reset />
      </div>
    </PageBody>
  );
}

function Reset() {
  const { t } = useTranslation("admin");
  const meta = useMeta();
  const reset = useResetDemo();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const close = () => {
    setOpen(false);
    setWord("");
    reset.reset();
  };
  return (
    <Panel title={t("reset.title")} meta={meta.data ? <span className="num">{t("reset.version", { version: meta.data.version })}</span> : undefined}>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <p className="font-bold">{t("reset.deletes")}</p>
          <ul className="mt-1 list-disc ps-5">
            <li>{t("reset.delete1")}</li>
            <li>{t("reset.delete2")}</li>
            <li>{t("reset.delete3")}</li>
            <li>{t("reset.delete4")}</li>
          </ul>
        </div>
        <div>
          <p className="font-bold">{t("reset.keeps")}</p>
          <ul className="mt-1 list-disc ps-5">
            <li>{t("reset.keep1")}</li>
            <li>{t("reset.keep2")}</li>
            <li>{t("reset.keep3")}</li>
            <li>{t("reset.keep4")}</li>
          </ul>
        </div>
      </div>
      <Button className="mt-4" variant="destructive" icon={<IconRotateClockwise2 aria-hidden />} onClick={() => setOpen(true)}>
        {t("reset.open")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => !o && close()}
        title={t("reset.askTitle")}
        description={t("reset.askBody")}
        footer={
          <>
            <Button onClick={close}>{t("reset.cancel")}</Button>
            <Button
              variant="destructive"
              disabled={word !== WORD}
              loading={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    close();
                    toast.ok(t("reset.done"));
                  },
                })
              }
            >
              {t("reset.confirm")}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => e.preventDefault()}
        >
          <Banner tone="warn" role="note">
            {t("reset.signedIn")}
          </Banner>
          <Field label={t("reset.type", { word: WORD })}>
            <Input value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          </Field>
          {reset.error ? <Problem error={reset.error} /> : null}
        </form>
      </Dialog>
    </Panel>
  );
}
