// /trackside (packages/trackside/README.md#the-trackside-page): an admin tool to test trackside cameras with a
// phone. Set up where the camera is and what it looks at, then it detects passing trains, reads
// their car numbers, and uploads the reports. Loaded only on this route: regular visitors never
// download any of it (nor the reader, which comes from a CDN when the camera starts).
//
// It's meant to be added to the home screen (public/trackside.webmanifest), where it runs full
// screen without the browser's bars. A home-screen app keeps storage of its own, so it signs in by
// itself: GitHub sign-in comes back here (…/auth/github/login?page=trackside), or a token copied
// from /admin can be pasted.

import React from "react";
import { callApi, loadToken, saveToken } from "../Admin/api.ts";
import { transitApi } from "../config.ts";
import { CameraStep } from "./CameraStep.tsx";
import { SetupStep, type SetupResult } from "./SetupStep.tsx";

const button =
  "rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800";
const primary =
  "rounded bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800";

export default function Trackside() {
  useHomeScreenApp();
  const [token, setToken] = React.useState<string | undefined>(() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
    if (fromHash) {
      saveToken(fromHash);
      history.replaceState(null, "", location.pathname);
      return fromHash;
    }
    return loadToken();
  });
  const [signInError] = React.useState(() => {
    const e = new URLSearchParams(location.hash.slice(1)).get("error");
    if (e) history.replaceState(null, "", location.pathname);
    return e;
  });
  const [me, setMe] = React.useState<{ login: string } | null | undefined>(
    transitApi ? undefined : null,
  );
  const [started, setStarted] = React.useState<SetupResult>();

  React.useEffect(() => {
    if (!transitApi) return;
    setMe(undefined);
    callApi<{ user: { login: string; role: string } | null }>(token, "auth/me")
      .then((r) => setMe(r.user?.role === "admin" ? r.user : null))
      .catch(() => setMe(null));
  }, [token]);

  if (me === undefined) return <Page>Checking sign-in…</Page>;
  // Without a server (local development) clips can still be tested; with one, only admins.
  if (transitApi && !me)
    return (
      <SignIn
        error={signInError}
        onToken={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  if (!started) return <SetupStep onDone={setStarted} />;
  return (
    <CameraStep
      setup={started.setup}
      file={started.file}
      token={token}
      onBack={() => setStarted(undefined)}
    />
  );
}

function SignIn({
  error,
  onToken,
}: {
  error: string | null;
  onToken: (token: string) => void;
}) {
  const [pasted, setPasted] = React.useState("");
  return (
    <Page>
      {error && (
        <p className="mb-3 text-red-700 dark:text-red-400">
          Sign-in didn't work ({error}). Try again.
        </p>
      )}
      <p className="mb-3">The trackside camera is for admins.</p>
      <a
        className={primary}
        href={`${transitApi}auth/github/login?page=trackside`}>
        Sign in with GitHub
      </a>
      <form
        className="mt-6 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pasted.trim()) onToken(pasted.trim());
        }}>
        <label className="w-full text-sm text-gray-600 dark:text-gray-400">
          Or paste a sign-in token (copy it on /admin, signed in, with "Copy
          token for the Trackside app"):
        </label>
        <input
          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className={button} type="submit">
          Use token
        </button>
      </form>
    </Page>
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

/**
 * While /trackside is open, the page describes itself as a home-screen app (iOS reads these when
 * "Add to Home Screen" is chosen) and lets content run under the notch and home indicator, which
 * the camera view pads around. The document itself never scrolls (only panels do): under the
 * status bar it can end up a little taller than the screen, and a drag on a panel with nothing
 * left to scroll then moved the whole page. Everything is restored on the way out, so the rest of
 * the site is unaffected.
 */
function useHomeScreenApp(): void {
  React.useEffect(() => {
    const added = [
      el("link", { rel: "manifest", href: "/trackside.webmanifest" }),
      el("link", { rel: "apple-touch-icon", href: "/trackside-icon-180.png" }),
      el("meta", { name: "apple-mobile-web-app-capable", content: "yes" }),
      el("meta", { name: "mobile-web-app-capable", content: "yes" }),
      el("meta", { name: "apple-mobile-web-app-title", content: "Trackside" }),
      el("meta", {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      }),
    ];
    for (const e of added) document.head.append(e);
    const viewport = document.querySelector<HTMLMetaElement>(
      'meta[name="viewport"]',
    );
    const content = viewport?.content;
    if (viewport) viewport.content = `${content}, viewport-fit=cover`;
    const title = document.title;
    document.title = "Trackside";
    const root = document.documentElement.style;
    const body = document.body.style;
    const saved = [root.overflow, root.overscrollBehavior, body.overflow];
    root.overflow = "hidden";
    root.overscrollBehavior = "none";
    body.overflow = "hidden";
    return () => {
      [root.overflow, root.overscrollBehavior, body.overflow] = saved as [
        string,
        string,
        string,
      ];
      for (const e of added) e.remove();
      if (viewport && content !== undefined) viewport.content = content;
      document.title = title;
    };
  }, []);
}

function el(tag: string, attrs: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
