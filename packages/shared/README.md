# @transitopia/shared

Definitions shared by the website and the server (and later the mobile app).

- `src/datasets.ts`: the dataset registry. Every dataset the site shows has an entry with its id, short credit, full legend, link and license. Map layers and the transit engine declare which ones they draw, and the attribution control credits exactly the ones visible ([docs/DESIGN.md → Attribution](../../docs/DESIGN.md#attribution)). Add an entry here, and a row in [DATA-LICENSES.md](../../DATA-LICENSES.md), before showing a new dataset.
