package org.transitopia;

import com.onthegomap.planetiler.ForwardingProfile;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.stats.Stats;
import com.onthegomap.planetiler.util.Translations;
import org.transitopia.layers.Cycling;

/**
 * Profile for generating the Transitopia Cycling layers
 */
public class TransitopiaCyclingProfile extends ForwardingProfile {

  public static final String OSM_SOURCE = "osm";

  public TransitopiaCyclingProfile(Planetiler runner) {
    this(runner.translations(), runner.config(), runner.stats());
  }

  public TransitopiaCyclingProfile(Translations translations, PlanetilerConfig config, Stats stats) {
    var cyclingLayer = new Cycling(config);
    registerHandler(cyclingLayer);
    registerSourceHandler(OSM_SOURCE, cyclingLayer::processAllOsm);

  }

  @Override
  public boolean caresAboutWikidataTranslation(OsmElement elem) {
    // For now, we're not using Wikidata translation
    return false;
  }

  @Override
  public String name() {
    return "Transitopia Cycling";
  }

  @Override
  public String description() {
    return "A vector map tileset with detailed cycling data.";
  }

  @Override
  public String attribution() {
    return "<a href=\"https://www.transitopia.org/\" target=\"_blank\">&copy; Transitopia</a>";
  }

  @Override
  public String version() {
    return "0.0.1";
  }

  @Override
  public long estimateIntermediateDiskBytes(long osmFileSize) {
    // in late 2021, a 60gb OSM file used 200GB for intermediate storage
    return osmFileSize * 200 / 60;
  }

  @Override
  public long estimateOutputBytes(long osmFileSize) {
    // in late 2021, a 60gb OSM file generated a 100GB output file
    return osmFileSize * 100 / 60;
  }

  @Override
  public long estimateRamRequired(long osmFileSize) {
    // 20gb for a 67gb OSM file is safe, although less might be OK too
    return osmFileSize * 20 / 67;
  }
}
