import { useEffect, useRef, useState } from "react";
import { fetchStatusSummary, type StatusSummary } from "./api";

export type SummaryState = {
  data: StatusSummary | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
};

/** Polls /api/status/summary on `intervalMs` and exposes typed data. */
export function useStatusSummary(intervalMs = 7000): SummaryState {
  const [state, setState] = useState<SummaryState>({
    data: null,
    loading: true,
    error: null,
    fetchedAt: null,
  });
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const ctrl = new AbortController();
      try {
        const data = await fetchStatusSummary(ctrl.signal);
        if (stoppedRef.current) return;
        setState({ data, loading: false, error: null, fetchedAt: Date.now() });
      } catch (err) {
        if (stoppedRef.current) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: (err as Error).message,
          fetchedAt: Date.now(),
        }));
      } finally {
        if (!stoppedRef.current) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };
    tick();

    return () => {
      stoppedRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return state;
}
