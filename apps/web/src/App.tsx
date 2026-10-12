import "./App.css";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import { Redirect, Route, Switch } from "wouter";

import { AsyncMapLibreGLLoader, Map } from "./Map/Map.tsx";
import { CyclingMap } from "./CyclingMap/CyclingMap.tsx";
import { ModeSwitch } from "./components/ModeSwitch.tsx";
import {
  LayersPanelHost,
  LayersPanelProvider,
} from "./components/LayersPanel.tsx";
import { Logo } from "./components/Logo.tsx";
import { ThemeProvider } from "./Theme/Theme.tsx";
import {
  AttributionControl,
  AttributionProvider,
} from "./Attribution/Attribution.tsx";

// The transit engine (and transit-core) is a separate chunk, loaded on /transit (apps/web/README.md#transit-mode).
const TransitMap = React.lazy(() => import("./TransitMap/TransitMap.tsx"));
// The admin pages (apps/web/README.md#admin), without the map.
const Admin = React.lazy(() => import("./Admin/Admin.tsx"));

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
      <LayersPanelProvider>
        <AsyncMapLibreGLLoader
          loadingContent={
            <div className="w-screen h-dvh text-center bg-gray-200 leading-[100dvh] text-gray-400 text-2xl dark:bg-gray-900">
              Loading Transitopia...
            </div>
          }>
          <Map
            header={
              <header className="map-header z-50 flex items-center border-gray-300 bg-(--header-background) shadow-md dark:border-gray-700 dark:text-gray-100">
                <Logo className="h-7 lg:h-[30px] mr-2" />
                <div className="flex-auto"></div>
                <ModeSwitch />
                <LayersPanelHost />
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
      </LayersPanelProvider>
    </AttributionProvider>
  );
}

export default App;
