# Planetiler Transitopia Profile

This Transitopia profile for [Planetiler](https://github.com/onthegomap/planetiler) generates
the following map layers:

- [Transitopia Cycling Map](https://www.transitopia.org/cycling)

## How to use

You need to have Java 21+ installed on your system.

First, compile the required `OsmProcessor.js` file:

```
cd transitopia-lib/
npm run build
```

Next, change back to the `map-layers` folder and run this command to compile the code, if you've just downloaded this or if you've modified the code:

```
./mvnw clean package
```

Then these commands to build the profile and generate the map:

```
rm data/sources/british_columbia.osm.pbf
java -XX:+UnlockExperimentalVMOptions -XX:+EnableJVMCI -Dpolyglot.engine.WarnInterpreterOnly=false -jar target/planetiler-*-with-deps.jar --force --download
```

The result will be in `./data/transitopia-cycling-british-columbia.pmtiles`
