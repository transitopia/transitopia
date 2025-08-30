// Based on planetiler/planetiler-core/src/main/java/com/onthegomap/planetiler/FeatureMerge.java
// https://github.com/onthegomap/planetiler/blob/main/planetiler-core/src/main/java/com/onthegomap/planetiler/FeatureMerge.java
// Planetiler source code is licensed under the Apache 2.0 License:
// https://github.com/onthegomap/planetiler/blob/8e33753/LICENSE
package org.transitopia.utils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import org.locationtech.jts.geom.CoordinateSequence;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LineString;

import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.geo.GeoUtils;
import com.onthegomap.planetiler.geo.GeometryException;
import com.onthegomap.planetiler.geo.GeometryPipeline;
import com.onthegomap.planetiler.geo.GeometryType;
import com.onthegomap.planetiler.geo.MutableCoordinateSequence;
import com.onthegomap.planetiler.util.LoopLineMerger;

/**
 * A utility class for merging linear features together if they have identical attributes.
 *
 * Unlike the base FeatureMerge class, this does not discard [OpenSteetMap] IDs when merging
 * features but rather creates a list of all the original IDs on the merged feature.
 *
 * This is modified from the base class `com.onthegomap.planetiler.FeatureMerge`; it would
 * be nice to just extend that class but it doesn't allow extension.
 */
public class FeatureMergeWithIds {

  // Unmodified comparator form base FeatureMerge class.
  private static final Comparator<WithIndex<?>> BY_HILBERT_INDEX = (o1, o2) -> Integer.compare(o1.hilbert, o2.hilbert);

  /**
   * Merges linestrings with the same attributes as {@link #mergeLineStrings(List, double, double, double, boolean)}
   * except sets {@code resimplify=false} by default.
   */
  public static List<VectorTile.Feature> mergeLineStrings(List<VectorTile.Feature> features,
    double minLength, double tolerance, double buffer) {
    return mergeLineStrings(features, minLength, tolerance, buffer, false);
  }

  public static List<VectorTile.Feature> mergeLineStrings(List<VectorTile.Feature> features,
    double minLength, double tolerance, double buffer, boolean resimplify) {
    return mergeLineStrings(features, attrs -> minLength, tolerance, buffer, resimplify, null);
  }

  /**
   * Merges linestrings with the same attributes as {@link #mergeLineStrings(List, double, double, double, boolean)}
   * except with a dynamic length limit computed by {@code lengthLimitCalculator} for the attributes of each group.
   */
  public static List<VectorTile.Feature> mergeLineStrings(List<VectorTile.Feature> features,
    Function<Map<String, Object>, Double> lengthLimitCalculator, double tolerance, double buffer, boolean resimplify,
    GeometryPipeline pipeline) {
    List<VectorTile.Feature> result = new ArrayList<>(features.size());
    var groupedByAttrs = FeatureMerge.groupByAttrs(features, result, GeometryType.LINE);
    for (List<VectorTile.Feature> groupedFeatures : groupedByAttrs) {
      VectorTile.Feature feature1 = groupedFeatures.getFirst();
      double lengthLimit = lengthLimitCalculator.apply(feature1.tags());

      // as a shortcut, can skip line merging only if:
      // - only 1 element in the group
      // - it doesn't need to be clipped
      // - and it can't possibly be filtered out for being too short
      // - and it does not need to be simplified
      if (groupedFeatures.size() == 1 && buffer == 0d && lengthLimit == 0 && (!resimplify || tolerance == 0)) {
        result.add(feature1);
      } else {
        List<Long> mergedIds = new ArrayList<>();
        LoopLineMerger merger = new LoopLineMerger()
          .setTolerance(tolerance)
          .setMergeStrokes(true)
          .setMinLength(lengthLimit)
          .setLoopMinLength(lengthLimit)
          .setStubMinLength(0.5)
          .setSegmentTransform(pipeline);
        for (VectorTile.Feature feature : groupedFeatures) {
          try {
            merger.add(feature.geometry().decode());
            mergedIds.add(feature.id());
          } catch (GeometryException e) {
            e.log("Error decoding vector tile feature for line merge: " + feature);
          }
        }
        List<LineString> outputSegments = new ArrayList<>();
        for (var line : merger.getMergedLineStrings()) {
          if (buffer >= 0) {
            removeDetailOutsideTile(line, buffer, outputSegments);
          } else {
            outputSegments.add(line);
          }
        }

        if (!outputSegments.isEmpty()) {
          outputSegments = sortByHilbertIndex(outputSegments);
          Geometry newGeometry = GeoUtils.combineLineStrings(outputSegments);
          VectorTile.Feature mergedFeature = feature1.copyWithNewGeometry(newGeometry);
          // We want to store the list of OSM Way IDs, but the vector tile spec doesn't allow
          // tag values to be a list:
          // https://github.com/mapbox/vector-tile-spec/blob/5330dfc6ba/2.1/vector_tile.proto#L15-L28
          // So we convert it to a comma-separated string: `owm_way_id="1234,4567"`
          // Surprisingly, this is more efficient than a series of separate integer tags
          // like `osm_way_id_0=1234,osm_way_id_1=4567`.
          final String mergedIdsStr = String.join(",", mergedIds.stream().sorted().map(String::valueOf).toList());
          mergedFeature.setTag("osm_way_ids", mergedIdsStr);
          result.add(mergedFeature);
        }
      }
    }
    return result;
  }

  /**
   * UNMODIFIED private helper method from FeatureMerge class.
   */
  private static void removeDetailOutsideTile(LineString input, double buffer, List<LineString> output) {
    MutableCoordinateSequence current = new MutableCoordinateSequence();
    CoordinateSequence seq = input.getCoordinateSequence();
    boolean wasIn = false;
    double min = -buffer, max = 256 + buffer;
    double x = seq.getX(0), y = seq.getY(0);
    Envelope env = new Envelope();
    Envelope outer = new Envelope(min, max, min, max);
    for (int i = 0; i < seq.size() - 1; i++) {
      double nextX = seq.getX(i + 1), nextY = seq.getY(i + 1);
      env.init(x, nextX, y, nextY);
      boolean nowIn = env.intersects(outer);
      if (nowIn || wasIn) {
        current.addPoint(x, y);
      } else { // out
        // wait to flush until 2 consecutive outs
        if (!current.isEmpty()) {
          if (current.size() >= 2) {
            output.add(GeoUtils.JTS_FACTORY.createLineString(current));
          }
          current = new MutableCoordinateSequence();
        }
      }
      wasIn = nowIn;
      x = nextX;
      y = nextY;
    }

    // last point
    double lastX = seq.getX(seq.size() - 1), lastY = seq.getY(seq.size() - 1);
    env.init(x, lastX, y, lastY);
    if (env.intersects(outer) || wasIn) {
      current.addPoint(lastX, lastY);
    }

    if (current.size() >= 2) {
      output.add(GeoUtils.JTS_FACTORY.createLineString(current));
    }
  }

  /**
   * UNMODIFIED private helper method from FeatureMerge class.
   */
  private static <G extends Geometry> List<G> sortByHilbertIndex(List<G> geometries) {
    return geometries.stream()
      .map(p -> new WithIndex<>(p, VectorTile.hilbertIndex(p)))
      .sorted(BY_HILBERT_INDEX)
      .map(d -> d.feature)
      .toList();
  }
  private record WithIndex<T>(T feature, int hilbert) {}
}
