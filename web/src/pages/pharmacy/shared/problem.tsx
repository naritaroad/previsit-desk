import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/api/errors";
import { describeError } from "@/lib/errors";
import { Banner, Button, ErrorState } from "@/ui";

/** Words for a failed request: our text, plus the server's field messages, which are already in the reader's language. */
export function useProblemText(): (e: unknown) => string {
  const { t } = useTranslation("errors");
  return useCallback(
    (e: unknown) => {
      const d = describeError(e);
      const own = t(d.key, d.params ?? {});
      const fields = e instanceof ApiError ? [...new Set(Object.values(e.fields).filter(Boolean))] : [];
      return fields.length > 0 ? [own, ...fields].join(" ") : own;
    },
    [t],
  );
}

/** A refused write, next to the control that caused it. */
export function Problem({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation("common");
  const text = useProblemText();
  if (!error) return null;
  return (
    <Banner tone="warn" role="alert" className={className} actions={onRetry && describeError(error).retryable ? <Button size="sm" onClick={onRetry}>{t("action.retry")}</Button> : undefined}>
      {text(error)}
    </Banner>
  );
}

/** A page whose record did not load. */
export function LoadProblem({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying?: boolean }) {
  const text = useProblemText();
  return (
    <ErrorState onRetry={describeError(error).retryable ? onRetry : undefined} retrying={retrying}>
      {text(error)}
    </ErrorState>
  );
}
