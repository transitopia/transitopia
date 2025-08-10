import React from "react";

import { useOsmNode } from "../OSMData/osm-data-loader.ts";
import { bikeParkingSchema } from "../OSMData/osm-micromobility.ts";

interface Props {
    featureType: "node";
    osmId: number | undefined;
    closeInfobox: () => void;
}

export const InfoboxBikeParking: React.FC<Props> = (props) => {

    const { data, error: osmError } = useOsmNode(props.osmId, bikeParkingSchema);
    if (data) console.log('data', data);

    if (osmError) {
        console.log("OpenStreetMap loading error:", osmError);
    }

    return <>
        <div className="flex">
            <div className="flex-1">
                {data?.name ?
                    <><strong>{data.name}</strong> (Bicycle Parking)</>
                    :
                    <strong>Bicycle Parking</strong>
                }
            </div>
            <div className="flex-none">
                <button className="hover:bg-gray-200 px-2 rounded-lg" onClick={props.closeInfobox}>x</button>
            </div>
        </div>
        {
            data ? <>
                {data.capacity ? <div>Capacity: {data.capacity} bikes.</div> : null}
            </> :
            osmError ? <p>Error: unable to load data from OpenStreetMap.</p> :
            <>Loading...</>
        }
        <br />
        <a className="text-slate-500 text-sm" href={`https://www.openstreetmap.org/${props.featureType}/${props.osmId}`}>View or edit this entry on OpenStreetMap</a>
    </>
}
