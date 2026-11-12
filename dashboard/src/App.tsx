import { useCallback, useEffect, useState } from "react";
import { getSession, signIn, signOut, type SignedIn } from "./lib/api";
import { SignInPage } from "./pages/SignInPage";
import { SignedInApp } from "./SignedInApp";

type Auth = { status: "loading" } | { status: "signedOut" } | ({ status: "signedIn" } & SignedIn);

type Props = { now?: Date };

export function App({ now = new Date() }: Props) {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });

  useEffect(() => {
    getSession()
      .then((s) => setAuth(s ? { status: "signedIn", ...s } : { status: "signedOut" }))
      .catch(() => setAuth({ status: "signedOut" }));
  }, []);

  const signedOut = useCallback(() => setAuth({ status: "signedOut" }), []);

  if (auth.status === "loading") {
    return (
      <main className="page" aria-busy="true">
        Loading...
      </main>
    );
  }
  if (auth.status === "signedOut") {
    return (
      <SignInPage
        onSignIn={async (username, password) =>
          setAuth({ status: "signedIn", ...(await signIn(username, password)) })
        }
      />
    );
  }
  return (
    <SignedInApp
      username={auth.username}
      notices={auth.notices}
      now={now}
      onSignOut={async () => {
        await signOut().catch(() => undefined);
        signedOut();
      }}
      onUnauthorized={signedOut}
    />
  );
}
