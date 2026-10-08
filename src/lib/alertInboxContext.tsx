import { createContext, useContext, type ReactNode } from "react";
import { useAlertInbox } from "./useAlertInbox";

type InboxApi = ReturnType<typeof useAlertInbox>;

const AlertInboxContext = createContext<InboxApi | null>(null);

/**
 * Provider that owns the single shared `useAlertInbox` instance for the
 * whole app. Anything that reads or mutates the inbox (header bell, the
 * Overview incidents list, future alert widgets) should consume this
 * context so their views stay in sync.
 */
export function AlertInboxProvider({ children, limit = 100 }: { children: ReactNode; limit?: number }) {
  const inbox = useAlertInbox(limit);
  return <AlertInboxContext.Provider value={inbox}>{children}</AlertInboxContext.Provider>;
}

export function useAlertInboxContext(): InboxApi {
  const ctx = useContext(AlertInboxContext);
  if (!ctx) {
    throw new Error("useAlertInboxContext must be used inside <AlertInboxProvider>");
  }
  return ctx;
}
