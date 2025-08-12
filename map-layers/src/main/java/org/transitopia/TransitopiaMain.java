package org.transitopia;

import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.config.Arguments;
import java.nio.file.Path;
import java.util.List;

/**
 * Main entrypoint for generating the Transitopia Maps
 */
public class TransitopiaMain {

  public static void main(String[] args) throws Exception {
    run(Arguments.fromArgsOrConfigFile(args));
  }

  static void run(Arguments arguments) throws Exception {
    Path dataDir = Path.of("data");
    Path sourcesDir = arguments.file("download_dir", "download directory", dataDir.resolve("sources"));
    // use --area=... argument, AREA=... env var or area=... in config to set the region of the world to use
    // will be ignored if osm_path or osm_url are set
    String area = arguments.getString(
      "area",
      "name of the extract to download if osm_url/osm_path not specified (i.e. 'monaco' 'rhode island' 'australia' or 'planet')",
      "british-columbia"
    );

    Planetiler.create(arguments)
      .setDefaultLanguages(List.of("en")) // For now we just need English
      // .fetchWikidataNameTranslations(sourcesDir.resolve("wikidata_names.json"))
      // defer creation of the profile because it depends on data from the runner
      .setProfile(TransitopiaCyclingProfile::new)
      .addOsmSource(TransitopiaCyclingProfile.OSM_SOURCE,
        sourcesDir.resolve(area.replaceAll("[^a-zA-Z]+", "_") + ".osm.pbf"),
        "planet".equalsIgnoreCase(area) ? ("aws:latest") : ("geofabrik:" + area))
      // override with --mbtiles=... argument or MBTILES=... env var or mbtiles=... in a config file
      .setOutput(dataDir.resolve("transitopia-cycling-" + area + ".pmtiles"))
      .run();
  }
}
