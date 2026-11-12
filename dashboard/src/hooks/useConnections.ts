import { useCallback, useEffect, useState } from "react";
import { ApiError, getConnections } from "../lib/api";
import type { Connection } from "../types";

export type ConnectionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; connections: Connection[]; notices: string[] };

export const useConnections = (onUnauthorized: () => void) => {
  const [state, setState] = useState<ConnectionsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", ...(await getConnections()) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
};
