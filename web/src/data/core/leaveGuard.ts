// Who has work that leaving would lose or leave unsent. Saved drafts do not count: they are kept.

import { Store } from "./env.ts";

export interface LeaveReason {
  id: string;
  /** i18n key that says what would be left behind, e.g. "errors:leave.unsent". */
  messageKey: string;
}

class LeaveGuard {
  readonly state = new Store<readonly LeaveReason[]>([]);
  private attached = false;

  set(reason: LeaveReason): () => void {
    this.state.set([...this.state.get().filter((r) => r.id !== reason.id), reason]);
    this.listen();
    return () => this.clear(reason.id);
  }
  clear(id: string): void {
    const next = this.state.get().filter((r) => r.id !== id);
    if (next.length !== this.state.get().length) this.state.set(next);
    this.listen();
  }
  get active(): boolean {
    return this.state.get().length > 0;
  }

  // beforeunload is only attached while needed: it disables the back/forward cache.
  private listen(): void {
    if (typeof window === "undefined" || this.attached === this.active) return;
    if (this.active) window.addEventListener("beforeunload", this.onBeforeUnload);
    else window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.attached = this.active;
  }
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    e.preventDefault();
  };
}

export const leaveGuard = new LeaveGuard();
