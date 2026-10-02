# Data licenses

The code in this repository is [MIT](LICENSE) licensed. Data has its own licenses, tracked per dataset. Each dataset the site shows also has an entry in the registry behind the map's credits (`packages/shared/src/datasets.ts`). *This is guidance, not legal advice.*

| Dataset | License |
|---|---|
| Derived from OpenStreetMap: SkyTrain track infrastructure (`regions/*/infrastructure/`), station facts from OSM, the cycling layer, basemap tiles | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), © OpenStreetMap contributors (required, since these are derivative databases of OSM) |
| Our own content: observations, disruptions, scenarios, config, annotations, fleet records, frequency scores, per-route statistics, observed stop times | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), © Transitopia contributors. Individual contents under the [DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/). Statistics and stop times derived from TransLink's feeds are our own analysis, but also subject to TransLink's terms (below). |
| Photos we host | Chosen per photo by the uploader: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) or [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (both accepted by Wikimedia Commons). Photos are creative works, not databases, so ODbL doesn't fit them. |
| Third-party data we republish | Its own terms, never relicensed |

Every export carries "© Transitopia contributors, ODbL 1.0" plus the credits of any third-party data it contains.

## Why ODbL

Anything derived from OSM is a derivative database of OSM, and if we publish it, it must be ODbL: our track graph, OSM-derived station facts, the cycling layer and the basemap. So part of our data is ODbL whatever we choose. We use **ODbL wherever we can, including our own content, with no dual licensing**: one license for all our data, the same as OSM's, is simplest to explain and keeps improvements open.

The alternative was CC BY 4.0, which asks only for credit and is easier for cities, consultants and journalists to reuse, but protects nothing: a company could take the data and improve it privately. ODbL asks anyone who publicly uses a modified or derived *database* to share it under ODbL; "produced works" (maps, images, reports) only need attribution. Ground facts people report ("this stop has no shelter") can still be verified and added to OSM by a mapper.

## Third-party sources

| Source | Terms | What we do |
|---|---|---|
| **TransLink** GTFS static and GTFS-realtime | [TransLink Open API terms of use](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use): a limited, revocable, non-exclusive license to use, reproduce and redistribute the data, with a required legend. No use of TransLink's trade-marks. Revocable on 10 days' notice. "Your API Key will authorize you to offer a maximum of 1,000 requests per day." Archives aren't mentioned either way. | Redistribute with the legend, which the site shows in full whenever TransLink data is visible. Stay within 1,000 requests a day. |
| **OpenStreetMap** | [ODbL 1.0](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors | Credited on the map. Our OSM-derived datasets are ODbL. |
| **Protomaps** basemap | Tiles derived from OSM (ODbL); the Protomaps software is BSD-licensed | Credit OSM and Protomaps. |
| **aisstream.io** (SeaBus AIS positions) | Limited to 3 connections per account (terms checked by Braden, 2026-10-02); no other restriction. | Shown live, as SeaBus positions. The recorded fixes for the vessels we track (the SeaBus fleet) may be republished, including in public snapshots. Production holds one connection. |
| **CPTDB wiki** | Community content under CC BY-SA | Can be used as a reference for cross-checking data, but bulk copying any of their data would likely not meet the SA requirement since our primary license for data is ODbL. |
| **Wikimedia Commons** photos | Per file (CC BY, CC BY-SA, public domain, …) | Picked by hand only; the license, author and source URL are stored and shown with each photo. |
| **GBFS feeds** (Mobi and scooter or e-bike operators), when added | Per operator, in each feed's `system_information.json` (`license_id` or `license_url`). Mobi's trip history uses a separate data license. | Check each feed's license before archiving or republishing it. |
| **City open data** (Vancouver and others), when added | Usually the Open Government Licence – Vancouver or similar | Per dataset, with attribution. |

Some of the data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.

## Contributions

By submitting data (a report, observation, correction or annotation), you grant Transitopia a perpetual, irrevocable, worldwide license to use your contribution, to publish it under ODbL, and to relicense it later under another open license. Photos are the exception: the license you choose for a photo applies to it.
