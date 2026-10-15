// Dates on the server. Service dates are "YYYYMMDD" everywhere (ServiceDate,
// packages/transit-core/src/time.ts); the database's date columns take ISO dates.

import type { ServiceDate } from "@transitopia/transit-core/time.ts";

/** A service date as an ISO date ("YYYY-MM-DD"), for date columns. */
export const isoDate = (date: ServiceDate): string =>
  Temporal.PlainDate.from(date).toString();
