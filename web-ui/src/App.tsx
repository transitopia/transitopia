import "./App.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { Redirect, Route, Switch } from "wouter";

import { AsyncMapLibreGLLoader, Map } from "./Map/Map.tsx";
import { CyclingMap } from "./CyclingMap/CyclingMap.tsx";
import { LinkWithQuery } from "./components/LinkWithQuery.tsx";
import { Icon } from "./components/Icon.tsx";
import { WalkingMap } from "./WalkingMap/WalkingMap.tsx";
import { MapOverlayWindow } from "./Map/MapOverlayWindow.tsx";

function App() {
  return (
    <AsyncMapLibreGLLoader
      loadingContent={
        <div className="w-screen h-screen text-center bg-gray-200 leading-[100vh] text-gray-400 text-2xl">
          Loading Transitopia...
        </div>
      }
    >
      <Map>
        <MapOverlayWindow className="top-5 flex items-center">
          <img
            src="/transitopia-logo-h.svg"
            alt="Transitopia"
            className="block h-7 lg:h-10 mr-2 lg:mr-4"
          />
          <div className="flex-auto"></div>
          {/*<LinkWithQuery href="/transit" className="mx-1 p-1  w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100" classNameActive="bg-transit-blue!"><Icon icon="bus-front-fill" altText="Transit" /></LinkWithQuery>*/}
          <LinkWithQuery
            href="/walking"
            className="mx-1 p-1 w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100"
            classNameActive="bg-pedestrian-orange!"
          >
            <Icon icon="person-walking" altText="Walking" />
          </LinkWithQuery>
          <LinkWithQuery
            href="/cycling"
            className="mx-1 p-1  w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100"
            classNameActive="bg-cyclist-green!"
          >
            <Icon icon="bicycle" altText="Cycling" />
          </LinkWithQuery>
        </MapOverlayWindow>
        <Switch>
          <Route path="/cycling">
            <CyclingMap />
          </Route>
          <Route path="/walking">
            <WalkingMap />
          </Route>
          <Route path="/">
            <Redirect to="/cycling" />
          </Route>
          <Route>
            {/* Not found */}
            <Redirect to="/" />
          </Route>
        </Switch>
      </Map>
    </AsyncMapLibreGLLoader>
  );
}

export default App;
