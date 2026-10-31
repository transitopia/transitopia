import React from "react";
import type { MapMouseEvent } from "maplibre-gl";

import { useAboutPanel } from "../Attribution/Attribution.tsx";
import { useLayersPanel } from "../components/LayersPanel.tsx";
import { MenuList, type MenuItem } from "../components/Menu.tsx";
import { useMap } from "./MapUtils.ts";

const ISSUES_URL = "https://github.com/transitopia/transitopia/issues";

interface Opened {
  x: number;
  y: number;
  lat: number;
  lng: number;
  zoom: number;
}

/** "49.27215, -123.13512": five decimals is about a metre. */
const formatCoordinates = (lat: number, lng: number) =>
  `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

const openWindow = (url: string) => window.open(url, "_blank", "noopener");

/**
 * The map's context menu (apps/web/README.md#context-menu): a right-click, or a long press on a
 * touch screen, opens a MenuList at that point to copy its coordinates, open the layers panel or
 * the About panel, look at the place on another map, or report an issue. Moving the map closes it.
 */
export const MapContextMenu: React.FC = () => {
  const map = useMap();
  const layers = useLayersPanel();
  const about = useAboutPanel();
  const [opened, setOpened] = React.useState<Opened>();
  const [notice, setNotice] = React.useState<{
    text: string;
    x: number;
    y: number;
  }>();

  React.useEffect(() => {
    if (!map) return;
    const onContextMenu = (e: MapMouseEvent) => {
      const { clientX, clientY } = e.originalEvent;
      setNotice(undefined);
      setOpened({
        x: clientX,
        y: clientY,
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
        zoom: map.getZoom(),
      });
    };
    const onMoveStart = () => setOpened(undefined);
    map.on("contextmenu", onContextMenu);
    map.on("movestart", onMoveStart);
    return () => {
      map.off("contextmenu", onContextMenu);
      map.off("movestart", onMoveStart);
    };
  }, [map]);

  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  let menu: React.ReactNode = null;
  if (opened) {
    const { x, y, lat, lng, zoom } = opened;
    const coordinates = formatCoordinates(lat, lng);
    // OpenStreetMap's zoom levels are for 256 px tiles, one more than MapLibre's (512 px).
    const osmZoom = Math.min(19, Math.round(zoom) + 1);
    const items: MenuItem[] = [
      {
        id: "coordinates",
        label: coordinates,
        onSelect: () => {
          navigator.clipboard.writeText(coordinates).then(
            () => setNotice({ text: "Coordinates copied", x, y }),
            () => setNotice({ text: "Couldn't copy the coordinates", x, y }),
          );
        },
      },
      {
        id: "layers",
        label: "Show legend and layers",
        onSelect: () => layers.setOpen(true),
      },
      {
        id: "osm",
        label: "Open in OpenStreetMap",
        onSelect: () =>
          openWindow(
            `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=${osmZoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`,
          ),
      },
      {
        id: "google",
        label: "Open in Google Maps",
        // Google's universal link: the app on phones that have it, the website elsewhere.
        onSelect: () =>
          openWindow(
            `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`,
          ),
      },
      {
        id: "about",
        label: "About Transitopia",
        onSelect: () => about.setOpen(true),
      },
      {
        id: "issue",
        label: "Report an issue or suggestion",
        onSelect: () => openWindow(ISSUES_URL),
      },
    ];
    menu = (
      <MenuList
        // A new right-click is a new menu (its position and first focus).
        key={`${x},${y}`}
        label="Map"
        items={items}
        anchor={{ left: x, right: x, top: y, bottom: y }}
        align="left"
        onClose={() => setOpened(undefined)}
      />
    );
  }

  return (
    <>
      {menu}
      <div role="status" className="pointer-events-none">
        {notice ?
          <div
            style={{ left: notice.x, top: notice.y + 4 }}
            className="fixed z-50 rounded-full border border-(--card-border) bg-(--card-bg) px-3 py-1.5 text-sm font-semibold text-(--card-text) shadow-[0_10px_28px_rgb(17_24_39/0.22)]">
            {notice.text}
          </div>
        : null}
      </div>
    </>
  );
};
