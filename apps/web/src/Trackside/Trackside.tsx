// /trackside (packages/trackside/README.md#the-trackside-page): an admin tool to test trackside cameras with a
// phone. Set up where the camera is and what it looks at, then it detects passing trains, reads
// their car numbers, and uploads the reports. Loaded only on this route: regular visitors never
// download any of it (nor the reader, which comes from a CDN when the camera starts).

import React from "react";
import type { CameraSetup } from "@transitopia/trackside/types.ts";
import { callApi, loadToken } from "../Admin/api.ts";
import { transitApi } from "../config.ts";
import { CameraStep } from "./CameraStep.tsx";
import { SetupStep, type SetupResult } from "./SetupStep.tsx";

export default function Trackside() {
  const [token] = React.useState(loadToken);
  const [me, setMe] = React.useState<{ login: string } | null | undefined>(
    transitApi ? undefined : null,
  );
  const [started, setStarted] = React.useState<SetupResult>();

  React.useEffect(() => {
    if (!transitApi) return;
    callApi<{ user: { login: string; role: string } | null }>(token, "auth/me")
      .then((r) => setMe(r.user?.role === "admin" ? r.user : null))
      .catch(() => setMe(null));
  }, [token]);

  if (me === undefined) return <Page>Checking sign-in…</Page>;
  // Without a server (local development) clips can still be tested; with one, only admins.
  if (transitApi && !me)
    return (
      <Page>
        <p>
          The trackside camera is for admins.{" "}
          <a className="underline" href="/admin">
            Sign in on the admin page
          </a>
          , then come back to <code>/trackside</code>.
        </p>
      </Page>
    );
  if (!started) return <SetupStep onDone={setStarted} />;
  return (
    <CameraStep
      setup={started.setup satisfies CameraSetup}
      file={started.file}
      token={token}
      onBack={() => setStarted(undefined)}
    />
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-gray-100 p-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <h1 className="mb-2 text-lg font-semibold">Trackside camera</h1>
      {children}
    </div>
  );
}
