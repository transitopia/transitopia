import "./App.css";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import { Redirect, Route, Switch } from "wouter";

import { AsyncMapLibreGLLoader, Map } from "./Map/Map.tsx";
import { CyclingMap } from "./CyclingMap/CyclingMap.tsx";
import { ModeLink } from "./components/ModeLink.tsx";
import { Icon } from "./components/Icon.tsx";
import { ThemeProvider } from "./Theme/Theme.tsx";
import {
  AttributionControl,
  AttributionProvider,
} from "./Attribution/Attribution.tsx";

// The transit engine (and transit-core) is a separate chunk, loaded on /transit (apps/web/README.md#transit-mode).
const TransitMap = React.lazy(() => import("./TransitMap/TransitMap.tsx"));
// The admin pages (apps/web/README.md#admin), without the map.
const Admin = React.lazy(() => import("./Admin/Admin.tsx"));

const modeButton =
  "mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-gray-50 hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700";

function App() {
  return (
    <ThemeProvider>
      <Switch>
        <Route path="/admin">
          <React.Suspense fallback={null}>
            <Admin />
          </React.Suspense>
        </Route>
        <Route>
          <MapApp />
        </Route>
      </Switch>
    </ThemeProvider>
  );
}

function MapApp() {
  return (
    <AttributionProvider>
      <AsyncMapLibreGLLoader
        loadingContent={
          <div className="w-screen h-dvh text-center bg-gray-200 leading-[100dvh] text-gray-400 text-2xl dark:bg-gray-900">
            Loading Transitopia...
          </div>
        }>
        <Map
          header={
            <header className="map-header z-50 flex items-center border-gray-500 bg-(--header-background) shadow-md dark:border-gray-600 dark:text-gray-100">
              <img
                src="/transitopia-logo-h.svg"
                alt="Transitopia"
                className="block h-7 lg:h-10 mr-2 lg:mr-4 dark:rounded-sm dark:bg-white dark:px-1"
              />
              <div className="flex-auto"></div>
              <ModeLink
                href="/transit"
                className={modeButton}
                classNameActive="bg-transit-blue! dark:text-gray-900">
                <Icon icon="bus-front-fill" altText="Transit" />
              </ModeLink>
              <ModeLink
                href="/cycling"
                className={modeButton}
                classNameActive="bg-cyclist-green! dark:text-gray-900">
                <Icon icon="bicycle" altText="Cycling" />
              </ModeLink>
            </header>
          }>
          <Switch>
            <Route path="/transit">
              <React.Suspense fallback={null}>
                <TransitMap />
              </React.Suspense>
            </Route>
            <Route path="/cycling">
              <CyclingMap />
            </Route>
            {/* Walking is disabled for now until it has real content (docs/DESIGN.md#goals-and-scope). */}
            <Route path="/walking">
              <Redirect to={`/cycling${location.hash}`} replace />
            </Route>
            <Route path="/">
              {/* Keeps the map position, including pre-V2 ?z=&lat=&lng= (converted by <Map>). */}
              <Redirect
                to={`/transit${location.search}${location.hash}`}
                replace
              />
            </Route>
            <Route>
              {/* Not found */}
              <Redirect to="/" replace />
            </Route>
          </Switch>
          <AttributionControl />
        </Map>
      </AsyncMapLibreGLLoader>
    </AttributionProvider>
  );
}

export default App;
