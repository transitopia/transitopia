// TransLink service alerts → draft disruptions (packages/transit-core/DESIGN.md#disruptions-and-alerts).
//
// Alerts carry structured route, stop and period fields, but the operating change is free text, e.g.
// "Trains will single-track between Bridgeport Station and Richmond-Brighouse Station" and
// "Waterfront Station - Bridgeport Station - 10 minutes". Formulaic phrases become a draft; anything
// else is kept as unparsed. Drafts never apply by themselves: a person confirms them, and says which
// track stays open, which alerts don't.

import type { Disruption } from "./types.ts";

export interface AlertPeriod {
  /** Epoch ms; undefined = open-ended. */
  start?: number;
  end?: number;
}

export interface ServiceAlert {
  id: string;
  /** Our route keys the alert names (e.g. "canada"). */
  lines: string[];
  stopIds: string[];
  periods: AlertPeriod[];
  cause?: number;
  effect?: number;
  header: string;
  description: string;
}

export interface AlertDraft {
  alert: ServiceAlert;
  /** The draft disruption, when the text says something we can model. */
  draft?: Disruption;
  /** Why not (e.g. "no single-tracking or headway phrase"). */
  unparsed?: string;
}

/**
 * "Trains will single-track in both directions between X Station & Y Station", "single track service
 * will be in effect between X Station & Y Station": any words up to "between", within one sentence.
 */
const SINGLE_TRACK =
  /single[- ]?track(?:ing)?\b[^.]*?\bbetween\s+(.+?)\s+Station\s*(?:and|&)\s*(.+?)\s+Station/gi;
/** "…please board all trains from Platform 2 at both stations": the platform (track) that stays open. */
const BOARD_FROM =
  /board\s+all\s+trains\s+from\s+Platform\s+(\d+)(\s+at\s+both\s+stations)?/i;
const HEADWAY =
  /([A-Z][\w.'’ -]*?)\s+Station\s*[-–]\s*([A-Z][\w.'’ -]*?)\s+Station\s*[-–]\s*(\d+)\s*min/g;
/** Open-ended alert periods are drafted as this long (s). */
const OPEN_ENDED_S = 24 * 3600;

/** A draft disruption for an alert, or why there isn't one. */
export function draftFromAlert(alert: ServiceAlert): AlertDraft {
  const text = `${alert.header}\n${alert.description}`;
  const line = alert.lines.length === 1 ? alert.lines[0]! : undefined;
  if (!line)
    return {
      alert,
      unparsed:
        alert.lines.length ?
          "names more than one line"
        : "names no SkyTrain line",
    };
  const singleTrack: NonNullable<Disruption["singleTrack"]> = [];
  const board = BOARD_FROM.exec(text);
  for (const m of text.matchAll(SINGLE_TRACK)) {
    const between: [string, string] = [clean(m[1]!), clean(m[2]!)];
    // Pre-filled when the alert names the platform; a person still confirms it.
    singleTrack.push({
      line,
      between,
      keep: board ? `${between[0]} Station @ Platform ${board[1]}` : "",
      ...(board?.[2] ? { pinEnds: true } : {}),
    });
  }
  const headway: NonNullable<Disruption["headway"]> = [];
  for (const m of text.matchAll(HEADWAY))
    headway.push({
      line,
      between: [clean(m[1]!), clean(m[2]!)],
      minS: Number(m[3]) * 60,
    });
  if (!singleTrack.length && !headway.length)
    return { alert, unparsed: "no single-tracking or headway phrase" };
  const active = alert.periods
    .filter((p) => p.start !== undefined || p.end !== undefined)
    .map((p) => {
      const from = p.start ?? p.end! - OPEN_ENDED_S * 1000;
      const until = p.end ?? from + OPEN_ENDED_S * 1000;
      return {
        from: new Date(from).toISOString(),
        until: new Date(until).toISOString(),
      };
    });
  if (!active.length) return { alert, unparsed: "no active period" };
  return {
    alert,
    draft: {
      id: `alert-${slug(alert.id)}`,
      source: "TransLink alert",
      text: firstSentence(alert.header),
      note: `${alert.header}\n${alert.description}`.trim(),
      status: "draft",
      alertId: alert.id,
      active,
      ...(singleTrack.length ? { singleTrack } : {}),
      ...(headway.length ? { headway } : {}),
    },
  };
}

/** "Canada Line Track Maintenance on Mon, Sept 28 from 9:00 PM until the end of service." */
const firstSentence = (s: string) =>
  /^.*?\.(?=\s|$)/.exec(s.trim())?.[0] ?? s.trim();
const clean = (s: string) => s.replace(/^(the|and)\s+/i, "").trim();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
