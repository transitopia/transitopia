package org.transitopia.layers;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.ForwardingProfile;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmRelationInfo;
import com.onthegomap.planetiler.util.MemoryEstimator;
import com.onthegomap.planetiler.util.ZoomFunction;
import java.util.List;


public class Cycling implements
    ForwardingProfile.LayerPostProcessor,
    ForwardingProfile.OsmRelationPreprocessor {

    private final PlanetilerConfig config;
    private double BUFFER_SIZE = 4.0;
    // When zoomed out more than this, don't encode details of the cycling paths (makes tiles too big)
    private int MIN_ZOOM_ATTR = 13;
    // Hide things like bike parking areas below this zoom level.
    private int MIN_ZOOM_DETAILS = 12;
    private static final String LAYER_NAME = "transitopia_cycling";
    // Minimum lengths for coalescing paths together at specific zoom levels
    private static final ZoomFunction.MeterToPixelThresholds MIN_LENGTH = ZoomFunction.meterThresholds()
        .put(7, 50)
        .put(6, 100)
        .put(5, 500)
        .put(4, 1_000);

    // A fully separated bike track that's off-street or has a physical barrier separating it from traffic
    private static final int COMFORT_MOST = 4;
    // e.g. shared lane on a quiet neighborhood street
    private static final int COMFORT_HIGH = 3;
    // e.g. a painted bike lane, but not separated from traffic
    private static final int COMFORT_LOW = 2;
    // e.g. a shared use lane on a busy street
    private static final int COMFORT_LEAST = 1;

    public Cycling(PlanetilerConfig config) {
        this.config = config;
    }

    @Override
    public String name() {
        return LAYER_NAME;
    }

    @Override
    public List<OsmRelationInfo> preprocessOsmRelation(OsmElement.Relation relation) {
        if (relation.hasTag("type", "route") && relation.hasTag("route", "bicycle")) {
            return List.of(new RouteRelationInfo(relation.id()));
        }
        return null;
    }

    public void processAllOsm(SourceFeature feature, FeatureCollector features) {
        if (feature.canBeLine()) {
            FeatureCollector.Feature newLine = null;

            // "OSM distinguishes between cycle lanes and cycle tracks:
            // A cycle *track* is separate from the road (off-road).
            // Tracks are typically separated from the road by e.g. curbs, parking lots, grass verges, trees, etc."
            if (feature.hasTag("highway", "cycleway")) {
                final boolean shared_with_pedestrians =
                    feature.hasTag("foot", "designated") && feature.hasTag("segregated", "no");
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", shared_with_pedestrians)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", shared_with_pedestrians ? COMFORT_HIGH : COMFORT_MOST)
                    .setAttr("oneway", feature.hasTag("oneway", "yes") ? 1 : 0) // For now we don't support 'reverse' one-way with -1
                    .setAttr("class", "track")
                    .setAttr("subclass", "cycleway");
            } else if (feature.hasTag("highway", "path", "pedestrian") && feature.hasTag("bicycle", "designated")) {
                final boolean shared_with_pedestrians =
                    (feature.hasTag("foot", "designated") || feature.hasTag("highway", "pedestrian")) &&
                        !feature.hasTag("segregated", "yes");
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", shared_with_pedestrians)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", shared_with_pedestrians ? COMFORT_HIGH : COMFORT_MOST)
                    .setAttr("oneway", feature.hasTag("oneway", "yes") ? 1 : 0) // For now we don't support 'reverse' one-way with -1
                    .setAttr("class", "track")
                    .setAttr("subclass", "path");
            } else if (feature.hasTag("highway") && feature.hasTag("cycleway", "track")) {
                final boolean shared_with_pedestrians =
                    feature.hasTag("foot", "designated") && !feature.hasTag("segregated", "yes");
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", shared_with_pedestrians)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", shared_with_pedestrians ? COMFORT_HIGH : COMFORT_MOST)
                    .setAttr("oneway", feature.hasTag("oneway", "yes") ? 1 : 0) // For now we don't support 'reverse' one-way with -1
                    .setAttr("class", "track")
                    .setAttr("subclass", "combined-" + feature.getTag("highway"));
            } else if (feature.hasTag("highway", "construction") && feature.hasTag("construction", "cycleway")) {
                // A new bike track under construction.
                final boolean shared_with_pedestrians =
                    feature.hasTag("foot", "designated") && !feature.hasTag("segregated", "yes");
                newLine = features.line(LAYER_NAME)
                    .setAttr("construction", true)
                    .setAttr("shared_with_pedestrians", shared_with_pedestrians)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", shared_with_pedestrians ? COMFORT_HIGH : COMFORT_MOST)
                    .setAttr("oneway", feature.hasTag("oneway", "yes") ? 1 : 0)
                    .setAttr("class", "track")
                    .setAttr("subclass", "cycleway");
                if (feature.hasTag("website")) {
                    newLine.setAttr("website", feature.getTag("website"));
                }
                if (feature.hasTag("opening_date")) {
                    newLine.setAttr("opening_date", feature.getTag("opening_date"));
                }
            }
            // TODO: support "T2 (alternative)" on https://wiki.openstreetmap.org/wiki/Bicycle (cycleway:right=track + cycleway:right:oneway=no)
            // A cycle *lane* lies within the roadway itself (on-road):
            else if (feature.hasTag("highway") && !feature.hasTag("oneway", "yes") &&
                (feature.hasTag("cycleway", "lane") ||
                    feature.hasTag("cycleway:both", "lane") ||
                    (feature.hasTag("cycleway:left", "lane") && feature.hasTag("cycleway:right", "lane")))) {
                // A bike lane on both sides of the roadway, not separated from traffic
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", false)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", COMFORT_LOW)
                    .setAttr("oneway", 0)
                    .setAttr("class", "lane")
                    .setAttr("side", "both");
            } else if (feature.hasTag("highway") && !feature.hasTag("oneway", "yes") &&
                ((feature.hasTag("cycleway:right", "lane") && feature.hasTag("cycleway:right:oneway", "no")) ||
                    (feature.hasTag("cycleway:left", "lane") && feature.hasTag("cycleway:left:oneway", "no")))) {
                // A two-way bike lane on one side of the roadway, not separated from traffic
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", false)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", COMFORT_LOW)
                    .setAttr("oneway", 0)
                    .setAttr("class", "lane")
                    .setAttr("side", feature.hasTag("cycleway:right", "lane") ? "right" : "left");
            } else if (feature.hasTag("highway") && feature.hasTag("oneway", "yes") &&
                (feature.hasTag("cycleway", "lane") ||
                    feature.hasTag("cycleway:right", "lane") ||
                    feature.hasTag("cycleway:left", "lane"))) {
                // A one-way bike lane on a one-way roadway, not separated from traffic
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", false)
                    .setAttr("shared_with_vehicles", false)
                    .setAttr("comfort", COMFORT_LOW)
                    .setAttr("oneway",
                        // In rare cases, there is a bike lane on both sides of a one way street.
                        // In even rarer cases, there is some other exotic lane type on one side, but we ignore that for now.
                        (feature.hasTag("cycleway:right", "lane") && feature.hasTag("cycleway:left", "lane")) ? 0 :
                            (feature.hasTag("cycleway:left", "lane") && feature.hasTag("cycleway:right", "lane")) ? 0 :
                            1 // Default is one way like the "parent" roadway
                    )
                    .setAttr("class", "lane")
                    .setAttr("side", feature.hasTag("cycleway:left", "lane") ? "left" : "right");
            } else if (feature.hasTag("highway") && feature.hasTag("cycleway", "shared_lane", "shared") ||
                feature.hasTag("cycleway:both", "shared_lane", "shared")) {
                // A lane that is shared with motor vehicles
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", false)
                    .setAttr("shared_with_vehicles", true)
                    .setAttr("comfort",
                        feature.hasTag("motor_vehicle", "private") ? COMFORT_HIGH :
                            (feature.hasTag("maxspeed") && feature.getLong("maxspeed") <= 30) ? COMFORT_HIGH :
                            COMFORT_LEAST)
                    .setAttr("oneway",
                        feature.hasTag("oneway:bicycle", "no") ? 0 :
                            feature.hasTag("oneway", "yes") ? 1 :
                            0
                    )
                    .setAttr("class", "lane");
            } else if (feature.hasTag("highway", "residential") && feature.hasTag("bicycle", "yes", "designated") &&
                (feature.hasTag("maxspeed") && feature.getLong("maxspeed") <= 30)) {
                // A slow street that bicycles can use
                newLine = features.line(LAYER_NAME)
                    .setAttr("shared_with_pedestrians", feature.hasTag("foot", "yes"))
                    .setAttr("shared_with_vehicles", true)
                    .setAttr("comfort", COMFORT_HIGH)
                    .setAttr("oneway",
                        feature.hasTag("oneway:bicycle", "no") ? 0 :
                            feature.hasTag("oneway", "yes") ? 1 :
                            0
                    )
                    .setAttr("class", "lane");
            }
            // TODO: support "L2" on https://wiki.openstreetmap.org/wiki/Bicycle (highway=* + cycleway:right=lane)
            // TODO: support other types of cycle paths

            if (newLine != null) {
                newLine
                    // .setAttr("osmId", feature.id())
                    .setAttrWithMinzoom("name", feature.getTag("name"), MIN_ZOOM_ATTR)
                    .setAttrWithMinzoom("surface", feature.getTag("surface"), MIN_ZOOM_ATTR)
                    .setBufferPixels(BUFFER_SIZE)
                    .setMinZoom(6);
                // If this feature is a part of any routes, record that:
                var partOfRoutes = feature.relationInfo(RouteRelationInfo.class);
                if (!partOfRoutes.isEmpty()) {
                    var routeIdsString = "";
                    for (var relation : partOfRoutes) {
                        if (routeIdsString != "") routeIdsString += ",";
                        routeIdsString += relation.relation().id;
                    }
                    newLine.setAttrWithMinzoom("routes", routeIdsString, MIN_ZOOM_ATTR);
                }
            }
        } else if (feature.isPoint()) {
            // Find bike rack/parking nodes
            if (feature.hasTag("amenity", "bicycle_parking")) {
                features.point(LAYER_NAME)
                    .setAttr("amenity", "bicycle_parking")
                    .setAttr("name", feature.getTag("name"))
                    .setAttr("osmNodeId", feature.id())
                    .setMinZoom(MIN_ZOOM_DETAILS);
            }
        }

        if (feature.canBePolygon()) {
            // Find bike rack/parking areas, e.g. https://www.openstreetmap.org/way/697625710
            if (feature.hasTag("amenity", "bicycle_parking")) {
                features.centroid(LAYER_NAME)
                    .setAttr("amenity", "bicycle_parking")
                    .setAttr("name", feature.getTag("name"))
                    .setAttr("osmWayId", feature.id())
                    .setMinZoom(MIN_ZOOM_DETAILS);
            }
        }
    }

    private record RouteRelationInfo(long id) implements OsmRelationInfo {

        @Override
        public long estimateMemoryUsageBytes() {
            return MemoryEstimator.CLASS_HEADER_BYTES + MemoryEstimator.estimateSizeLong(id);
        }
    }

    @Override
    public List<VectorTile.Feature> postProcess(int zoom, List<VectorTile.Feature> items) {
        final String LIMIT_MERGE_TAG = "noMerge";
        double tolerance = config.tolerance(zoom);
        double minLength = coalesce(MIN_LENGTH.apply(zoom), 0).doubleValue();

        // don't merge road segments with "oneway" tag
        // TODO: merge while preserving "oneway" instead ignoring
        int onewayId = 1;
        for (var item : items) {
            var oneway = item.tags().get("oneway");
            if (oneway instanceof Number n && n.intValue() == 1) {
                item.tags().put(LIMIT_MERGE_TAG, onewayId++);
            }
        }

        var merged = FeatureMerge.mergeLineStrings(items, minLength, tolerance, BUFFER_SIZE);

        for (var item : merged) {
            item.tags().remove(LIMIT_MERGE_TAG);
        }
        return merged;
    }

    private static <T> T coalesce(T a, T b) {
        return a != null ? a : b;
    }
}
