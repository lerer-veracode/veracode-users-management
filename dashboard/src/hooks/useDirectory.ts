import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getRoles, getTeams, getUserDetails, getUsers } from "../lib/api";
import type { Role, Source, TeamOption, User } from "../types";

export type DirectoryState =
  | { status: "no-connection" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      source: Source;
      users: User[];
      roles: Role[];
      teams: TeamOption[];
      // "loading" while last login, type and MFA are read after the first view, or why they
      // couldn't be (docs/PLAN_CACHE.md, phase 6).
      details: "done" | "loading" | { error: string };
    };

// The users and roles of the chosen connection, read live from Veracode through the backend.
// Nothing loads until a connection is chosen, and an answer for a connection that is no
// longer chosen is ignored, so the list on screen always matches the connection shown.
// activeId: undefined while the connections load, null when none is chosen.
export const useDirectory = (activeId: string | null | undefined, onUnauthorized: () => void) => {
  const [state, setState] = useState<DirectoryState>({ status: "loading" });
  const latest = useRef(0);

  // fresh reads users, roles and teams afresh from Veracode, for Refresh and Try again. Without
  // it the backend answers from what it keeps.
  const reload = useCallback(
    async (fresh = false) => {
      const request = ++latest.current;
      if (activeId === undefined) return setState({ status: "loading" });
      if (activeId === null) return setState({ status: "no-connection" });
      setState({ status: "loading" });
      try {
        const [users, roles, teams] = await Promise.all([
          getUsers(fresh),
          getRoles(fresh),
          getTeams(fresh),
        ]);
        if (request !== latest.current) return;
        if ([users, roles, teams].some((x) => x.source.id !== activeId)) {
          return setState({
            status: "error",
            message: "The connection changed. Refresh to try again.",
          });
        }
        setState({
          status: "ready",
          source: users.source,
          users: users.users,
          roles: roles.roles,
          teams: teams.teams,
          details: users.complete ? "done" : "loading",
        });
        if (users.complete) return;
        // The first view is on screen; the rest follows.
        try {
          const full = await getUserDetails();
          if (request !== latest.current || full.source.id !== activeId) return;
          setState((s) =>
            s.status === "ready" ? { ...s, users: full.users, details: "done" } : s,
          );
        } catch (e) {
          if (request !== latest.current) return;
          if (e instanceof ApiError && e.status === 401) return onUnauthorized();
          const error = e instanceof Error ? e.message : String(e);
          setState((s) => (s.status === "ready" ? { ...s, details: { error } } : s));
        }
      } catch (e) {
        if (request !== latest.current) return;
        if (e instanceof ApiError && e.status === 401) return onUnauthorized();
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [activeId, onUnauthorized],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Reads the teams again (the backend keeps them until a refresh), keeping the rest on screen.
  const refreshTeams = useCallback(async () => {
    const request = latest.current;
    try {
      const { source, teams } = await getTeams(true);
      if (request !== latest.current || source.id !== activeId) return;
      setState((s) => (s.status === "ready" ? { ...s, teams } : s));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      throw e;
    }
  }, [activeId, onUnauthorized]);

  return { state, reload, refreshTeams };
};
