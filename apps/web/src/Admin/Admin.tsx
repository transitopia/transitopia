// /admin (apps/web/README.md#admin): the server's status, the review queue for corrections, and the
// feature registry's tools (Features.tsx). Disruptions drafted from TransLink alerts, and
// observation sets, are edited here, previewed on the map as dispatch versions nobody else sees,
// then confirmed (or discarded). Admins sign in with GitHub;
// the server returns a bearer token in the URL fragment, kept in localStorage.

import React from "react";
import { transitApi } from "../config.ts";
import { Logo } from "../components/Logo.tsx";
import {
  CallContext,
  loadToken,
  makeCall,
  saveToken,
  useAdmin,
  useCorrections,
  useSignOut,
} from "./api.ts";
import { DisruptionCard } from "./DisruptionCard.tsx";
import { Features } from "./Features.tsx";
import { NewCorrection } from "./NewCorrection.tsx";
import { ObservationCard } from "./ObservationCard.tsx";
import { isOpen } from "./Review.tsx";
import { Status } from "./Status.tsx";
import { button, card, errorText, primary } from "./styles.ts";

const SIGN_IN_ERRORS: Record<string, string> = {
  "not-admin": "That GitHub account isn't an admin here.",
  expired: "The sign-in took too long or was started elsewhere. Try again.",
  github: "GitHub didn't confirm the sign-in. Try again.",
};

export default function Admin() {
  const [token, setToken] = React.useState<string | undefined>(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromHash = hash.get("token");
    if (fromHash) {
      saveToken(fromHash);
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    return loadToken();
  });
  const call = React.useMemo(() => makeCall(token), [token]);
  return (
    <CallContext value={call}>
      <Page
        token={token}
        onSignedOut={() => {
          saveToken(undefined);
          setToken(undefined);
        }}
      />
    </CallContext>
  );
}

function Page(props: { token: string | undefined; onSignedOut: () => void }) {
  const [signInError] = React.useState(() => {
    const e = new URLSearchParams(location.hash.slice(1)).get("error");
    if (e) history.replaceState(null, "", location.pathname);
    return e ? (SIGN_IN_ERRORS[e] ?? e) : undefined;
  });
  const me = useAdmin(props.token);
  const signOut = useSignOut(props.onSignedOut);

  return (
    <div className="min-h-dvh bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center gap-3 border-b border-gray-300 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <a href="/transit">
          <Logo className="h-7" />
        </a>
        <h1 className="text-lg font-semibold">Admin</h1>
        <div className="flex-1" />
        {me ?
          <>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {me.login}
            </span>
            <button type="button" className={button} onClick={signOut}>
              Sign out
            </button>
          </>
        : null}
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {!transitApi ?
          <p className={card}>
            No server configured: set <code>VITE_TRANSIT_API</code> (e.g.
            http://localhost:8787/).
          </p>
        : me === undefined ?
          <p>Loading…</p>
        : me === null ?
          <div className={card}>
            {signInError ?
              <p className="mb-3 text-red-700 dark:text-red-400">
                {signInError}
              </p>
            : null}
            <p className="mb-3">
              Sign in with a GitHub account that's an admin on this server.
            </p>
            <a className={primary} href={`${transitApi}auth/github/login`}>
              Sign in with GitHub
            </a>
          </div>
        : <Dashboard />}
      </main>
    </div>
  );
}

function Dashboard() {
  const { data, error } = useCorrections();
  return (
    <>
      <Status />
      {error ?
        <p className={errorText}>{error.message}</p>
      : null}
      {data ?
        <>
          <Section title="Disruptions to review" empty="Nothing to review.">
            {data.disruptions
              .filter((d) => isOpen(d.state))
              .map((d) => (
                <DisruptionCard key={d.id} row={d} />
              ))}
          </Section>
          <Section title="Observations to review" empty="Nothing to review.">
            {data.observationSets
              .filter((o) => isOpen(o.state))
              .map((o) => (
                <ObservationCard key={o.id} row={o} />
              ))}
          </Section>
          <NewCorrection />
          <Features />
          {data.unparsedAlerts.length ?
            <Section title="SkyTrain alerts without a draft" empty="">
              {data.unparsedAlerts.map((a) => (
                <div key={a.id} className={card}>
                  <p className="text-sm font-medium">
                    {a.lines.join(", ")}: {a.header}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    Alert {a.id}: {a.reason}. Add a disruption by hand if it
                    changes service.
                  </p>
                </div>
              ))}
            </Section>
          : null}
          <Section title="Confirmed and discarded" empty="None yet.">
            {data.disruptions
              .filter((d) => !isOpen(d.state))
              .map((d) => (
                <DisruptionCard key={d.id} row={d} />
              ))}
            {data.observationSets
              .filter((o) => !isOpen(o.state))
              .map((o) => (
                <ObservationCard key={o.id} row={o} />
              ))}
          </Section>
        </>
      : null}
    </>
  );
}

function Section(props: {
  title: string;
  empty: string;
  children: React.ReactNode[] | React.ReactNode;
}) {
  const items = React.Children.toArray(props.children);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{props.title}</h2>
      {items.length ?
        items
      : <p className="text-sm text-gray-600 dark:text-gray-400">
          {props.empty}
        </p>
      }
    </section>
  );
}
