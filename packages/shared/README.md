# @transitopia/shared

Definitions shared by the website and the server (and later the mobile app).

- `src/datasets.ts`: the dataset registry. Every dataset the site shows has an entry with its id, short credit, full legend, link and license. Map layers and the transit engine declare which ones they draw, and the attribution control credits exactly the ones visible ([docs/DESIGN.md → Attribution](../../docs/DESIGN.md#attribution)). Add an entry here, and a row in [DATA-LICENSES.md](../../DATA-LICENSES.md), before showing a new dataset.
- `src/admin-api.ts`: the admin API (`/auth/*`, `/admin/api/*`) as zod schemas, used by the server ([apps/server → Admin API and sign-in](../../apps/server/README.md#admin-api-and-sign-in)) and `/admin` ([apps/web → Admin](../../apps/web/README.md#admin)). `ReviewState` here is also the database's (`packages/db/src/schema.ts`). Timestamps parse to `Date`s, as the server's rows hold them. Correction bodies are only checked for being objects: their formats belong to transit-core, and the server validates them.
