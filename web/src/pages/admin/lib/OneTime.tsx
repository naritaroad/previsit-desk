import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OneTimePassword } from "@/api/types";
import { Banner, Button, Checkbox, Dialog } from "@/ui";

/** The only time this password is on screen. Closing asks for a tick, so nobody loses it by pressing Esc. */
export function OneTimeDialog({ result, created, onClose }: { result: OneTimePassword | null; created?: boolean; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [noted, setNoted] = useState(false);
  const close = () => {
    setCopied(null);
    setNoted(false);
    onClose();
  };
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(o) => !o && noted && close()}
      noClose
      title={t(created ? "oneTime.created" : "oneTime.reset", { name: result?.account.display_name ?? "" })}
      description={t("oneTime.body")}
      footer={
        <Button variant="primary" disabled={!noted} onClick={close}>
          {t("oneTime.close")}
        </Button>
      }
    >
      <div className="grid gap-4">
        <p>
          {t("oneTime.username")} <b className="num">{result?.account.username}</b>
        </p>
        <div className="one-time">
          <code translate="no">{result?.password}</code>
          <Button
            icon={copied === "yes" ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
            onClick={() => {
              if (!result) return;
              navigator.clipboard.writeText(result.password).then(
                () => setCopied("yes"),
                () => setCopied("no"),
              );
            }}
          >
            {t(copied === "yes" ? "oneTime.copied" : "oneTime.copy")}
          </Button>
        </div>
        <span className="sr-only" role="status">
          {copied === "yes" ? t("oneTime.copied") : ""}
        </span>
        {copied === "no" && <Banner tone="warn">{t("oneTime.copyFailed")}</Banner>}
        <Banner tone="info" role="note">
          {t("oneTime.note")}
        </Banner>
        <Checkbox label={t("oneTime.noted")} checked={noted} onCheckedChange={(v) => setNoted(v === true)} />
      </div>
    </Dialog>
  );
}
