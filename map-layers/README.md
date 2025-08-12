# Planetiler Transitopia Profile

This Transitopia profile for [Planetiler](https://github.com/onthegomap/planetiler) generates
the following map layers:
  * [Transitopia Cycling Map](https://www.transitopia.org/cycling)

## How to use

You need to have a recent version of Java installed on your system.

First, run this command to compile the code, if you've just downloaded this or if you've modified the code:

```
./mvnw clean package
```

Then these commands to build the profile and generate the map:

```
rm data/sources/british_columbia.osm.pbf
java -jar target/planetiler-*-with-deps.jar --force --download
```

The result will be in `./data/transitopia-cycling-british-columbia.pmtiles`
