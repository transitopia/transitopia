// OSM elements as the cycling pipeline reads them: osmium's OPL text
// (https://osmcode.org/opl-file-format/), one element a line, with way node locations added
// (`osmium add-locations-to-ways`) and no metadata.

export type Tags = Readonly<Record<string, string>>;

export interface OsmNode {
  type: "node";
  id: number;
  tags: Tags;
  lon: number;
  lat: number;
}

export interface OsmWay {
  type: "way";
  id: number;
  tags: Tags;
  nodes: number[];
  /** Each node's [lon, lat]; undefined where the extract has no location for it. */
  coords: ([number, number] | undefined)[];
}

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

export interface OsmRelation {
  type: "relation";
  id: number;
  tags: Tags;
  members: OsmMember[];
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

const MEMBER_TYPES = { n: "node", w: "way", r: "relation" } as const;

/** OPL escapes anything outside a safe set as %<hex code point>%. */
function unescape(s: string): string {
  return s.includes("%") ?
      s.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) =>
        String.fromCodePoint(parseInt(hex, 16)),
      )
    : s;
}

function parseTags(s: string): Tags {
  const tags: Record<string, string> = {};
  if (!s) return tags;
  for (const kv of s.split(",")) {
    const eq = kv.indexOf("=");
    tags[unescape(eq < 0 ? kv : kv.slice(0, eq))] =
      eq < 0 ? "" : unescape(kv.slice(eq + 1));
  }
  return tags;
}

/** "x<lon>y<lat>" (or "x y" without a location) after a way's node id. */
function parseLocation(s: string): [number, number] | undefined {
  const y = s.indexOf("y");
  const lon = s.slice(1, y);
  const lat = s.slice(y + 1);
  return lon && lat ? [Number(lon), Number(lat)] : undefined;
}

/** One OPL line as an element; undefined for blank lines and changesets. */
export function parseOpl(line: string): OsmElement | undefined {
  const fields = line.trim().split(" ");
  const head = fields[0];
  if (!head) return undefined;
  const id = Number(head.slice(1));
  const field = (c: string) => {
    const f = fields.find((x) => x.startsWith(c));
    return f === undefined ? undefined : f.slice(1);
  };
  const tags = parseTags(field("T") ?? "");
  switch (head[0]) {
    case "n":
      return {
        type: "node",
        id,
        tags,
        lon: Number(field("x")),
        lat: Number(field("y")),
      };
    case "w": {
      const nodes: number[] = [];
      const coords: ([number, number] | undefined)[] = [];
      for (const ref of (field("N") ?? "").split(",")) {
        if (!ref) continue;
        const x = ref.indexOf("x");
        nodes.push(Number(ref.slice(1, x < 0 ? undefined : x)));
        coords.push(x < 0 ? undefined : parseLocation(ref.slice(x)));
      }
      return { type: "way", id, tags, nodes, coords };
    }
    case "r": {
      const members: OsmMember[] = [];
      for (const m of (field("M") ?? "").split(",")) {
        if (!m) continue;
        const at = m.indexOf("@");
        const type = MEMBER_TYPES[m[0] as keyof typeof MEMBER_TYPES];
        if (!type) continue;
        members.push({
          type,
          ref: Number(m.slice(1, at)),
          role: unescape(m.slice(at + 1)),
        });
      }
      return { type: "relation", id, tags, members };
    }
    default:
      return undefined;
  }
}
