import { IconLock, IconPlugConnectedX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router";

import { paths } from "@/lib/links";
import { canEnter, homePath } from "@/lib/permissions";
import { Button, ButtonLink, EmptyState, Spinner } from "@/ui";

import { BrandMark } from "@/shells/parts";
import { SignedIn } from "./session";
import { useSession } from "./session-context";

/** Full-page frame for states that come before a shell. */
export function Bare({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center p-6" data-ws="public" data-density="comfortable">
      <div className="w-full max-w-lg">{children}</div>
    </main>
  );
}

export function FullPageLoading() {
  const { t } = useTranslation("common");
  return (
    <div className="grid min-h-dvh place-items-center p-6" data-ws="public">
      <div className="grid justify-items-center gap-4 text-ink">
        <span className="size-10">
          <BrandMark />
        </span>
        <Spinner label={t("state.loading")} />
      </div>
    </div>
  );
}

/** Signed in, and the role owns this workspace. The server checks every request again. */
export function RequireWorkspace({ children }: { children: ReactNode }) {
  const { t } = useTranslation("shell");
  const { status, me, expired, retry } = useSession();
  const location = useLocation();
  if (status === "loading") return <FullPageLoading />;
  if (status === "unreachable")
    return (
      <Bare>
        <EmptyState icon={<IconPlugConnectedX aria-hidden />} title={<h1 tabIndex={-1}>{t("guard.unreachableTitle")}</h1>} action={<Button onClick={retry}>{t("guard.retry")}</Button>}>
          {t("guard.unreachableBody")}
        </EmptyState>
      </Bare>
    );
  if (!me) {
    const to = paths.login(location.pathname + location.search);
    return <Navigate to={expired ? `${to}${to.includes("?") ? "&" : "?"}expired=1` : to} replace />;
  }
  // With a one-time password every other endpoint answers 403: the settings page shows the password form first.
  const settings = `${homePath(me)}/settings`;
  if (me.must_change_password && location.pathname !== settings) return <Navigate to={`${settings}?password=1`} replace />;
  if (!canEnter(me, location.pathname))
    return (
      <Bare>
        <EmptyState
          icon={<IconLock aria-hidden />}
          title={<h1 tabIndex={-1}>{t("guard.forbiddenTitle")}</h1>}
          action={
            <ButtonLink to={homePath(me)} variant="primary">
              {t("guard.goHome")}
            </ButtonLink>
          }
        >
          {t("guard.forbiddenBody", { name: me.display_name, role: t(`role.${me.role}`) })}
        </EmptyState>
      </Bare>
    );
  return <SignedIn>{children}</SignedIn>;
}
