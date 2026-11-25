import { IconMapQuestion, IconRefreshAlert } from "@tabler/icons-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import { homePath } from "@/lib/permissions";
import { Button, ButtonLink, EmptyState } from "@/ui";

import { Bare } from "./guards";
import { useSession } from "./session-context";

const CHUNK = /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|ChunkLoadError|error loading dynamically/i;

/** A new version was deployed while this tab was open: the old chunks are gone. Reload once, then ask. */
function useChunkReload(error: unknown): boolean {
  const stale = error instanceof Error && CHUNK.test(error.message);
  useEffect(() => {
    if (!stale || !navigator.onLine) return;
    try {
      if (sessionStorage.getItem("pv-reloaded") === location.pathname) return;
      sessionStorage.setItem("pv-reloaded", location.pathname);
      location.reload();
    } catch {
      /* no storage: the button below does it */
    }
  }, [stale]);
  return stale;
}

export function NotFound({ bare }: { bare?: boolean }) {
  const { t } = useTranslation("shell");
  const { me } = useSession();
  const body = (
    <EmptyState
      icon={<IconMapQuestion aria-hidden />}
      title={<h1 tabIndex={-1}>{t("notFound.title")}</h1>}
      action={
        <span className="flex flex-wrap gap-3">
          <ButtonLink to={homePath(me)} variant="primary">
            {me ? t("guard.goHome") : t("notFound.home")}
          </ButtonLink>
          <ButtonLink to="/emergency">{t("footer.emergency")}</ButtonLink>
        </span>
      }
    >
      {t("notFound.body")}
    </EmptyState>
  );
  return bare ? <Bare>{body}</Bare> : <div className="mx-auto max-w-lg py-16">{body}</div>;
}

/** errorElement of every workspace: the shell around it keeps working. */
export function RouteError({ bare }: { bare?: boolean }) {
  const { t } = useTranslation("shell");
  const error = useRouteError();
  const stale = useChunkReload(error);
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound bare={bare} />;
  if (import.meta.env.DEV) console.error(error);
  const body = (
    <EmptyState
      icon={<IconRefreshAlert aria-hidden />}
      title={<h1 tabIndex={-1}>{stale ? t("crash.staleTitle") : t("crash.title")}</h1>}
      action={
        <span className="flex flex-wrap items-center gap-4">
          <Button variant="primary" onClick={() => location.reload()}>
            {t("crash.reload")}
          </Button>
          <Link className="link" to="/">
            {t("notFound.home")}
          </Link>
        </span>
      }
    >
      <div role="alert">{stale ? t("crash.staleBody") : t("crash.body")}</div>
    </EmptyState>
  );
  return bare ? <Bare>{body}</Bare> : <div className="mx-auto max-w-lg py-16">{body}</div>;
}
