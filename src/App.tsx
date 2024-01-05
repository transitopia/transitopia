import './App.css';
import "maplibre-gl/dist/maplibre-gl.css";
import { Redirect, Route, Switch } from "wouter";

import { Map } from "./Map/Map.tsx";
import { CyclingMap } from './CyclingMap/CyclingMap.tsx';
import { LinkWithQuery } from './components/LinkWithQuery.tsx';
import { Icon } from './components/Icon.tsx';
import { WalkingMap } from './WalkingMap/WalkingMap.tsx';
import { MapOverlayWindow } from './Map/MapOverlayWindow.tsx';

function App() {

    return (
        <>
            <Map>
                <MapOverlayWindow className="top-5 flex items-center">
                    <img src="/transitopia-logo-h.svg" alt="Transitopia" className='block h-7 lg:h-10 mr-2 lg:mr-4' />
                    <div className="flex-auto"></div>
                    {/*<LinkWithQuery href="/transit" className="mx-1 p-1  w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100" classNameActive="!bg-transitBlue"><Icon icon="bus-front-fill" altText="Transit" /></LinkWithQuery>*/}
                    <LinkWithQuery href="/walking" className="mx-1 p-1 w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100" classNameActive="!bg-pedestrianOrange"><Icon icon="person-walking" altText="Walking" /></LinkWithQuery>
                    <LinkWithQuery href="/cycling" className="mx-1 p-1  w-8 h-8 text-center rounded-full bg-gray-50 hover:bg-gray-100" classNameActive="!bg-cyclistGreen"><Icon icon="bicycle" altText="Cycling" /></LinkWithQuery>
                </MapOverlayWindow>
                <Switch>
                    <Route path="/cycling"><CyclingMap /></Route>
                    <Route path="/walking"><WalkingMap /></Route>
                    <Route path="/"></Route>
                    <Route>
                        {/* Not found */}
                        <Redirect to="/" />
                    </Route>
                </Switch>
            </Map>
        </>
    )
}

export default App
