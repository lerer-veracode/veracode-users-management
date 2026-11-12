import { useEffect, useState } from "react";

export const ROUTES = ["users", "import", "connections", "activity"] as const;
export type Route = (typeof ROUTES)[number];

const read = (): Route => ROUTES.find((r) => `#/${r}` === window.location.hash) ?? "users";

export const useHashRoute = (): Route => {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};
