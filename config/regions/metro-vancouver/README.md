# Metro Vancouver

Where `/transit` opens, showing TransLink's feed ([config/feeds/translink/](../../feeds/translink/README.md)) and Hullo's ferry to Nanaimo ([config/feeds/hullo/](../../feeds/hullo/README.md)). A region is only a view now ([docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)):

| Path | What |
|---|---|
| `region.json` | Its name, bbox, the first view of `/transit`, and its feeds |

What we know about how things run is with what they're about: the SkyTrain's track and operations in its rail network ([config/networks/skytrain/](../../networks/skytrain/README.md)), and the SeaBus, West Coast Express and buses in TransLink's feed ([config/feeds/translink/](../../feeds/translink/README.md)), each with its open questions.
