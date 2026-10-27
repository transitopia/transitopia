// Reading a local PMTiles v3 file tile by tile (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md),
// for tools that look at every tile (pipelines/inspect-cycling-tiles.ts). The `pmtiles` package reads
// one tile at a time by z/x/y and can't list what a file holds.

import { open, type FileHandle } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { bytesToHeader, tileIdToZxy, type Header } from "pmtiles";

/** A tile's position and its bytes, decompressed. */
export interface TileData {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

const HEADER_BYTES = 127;
/** PMTiles' compression codes. */
const NONE = 1;
const GZIP = 2;

function decompress(buf: Uint8Array, compression: number): Uint8Array {
  if (compression === GZIP) return gunzipSync(buf);
  if (compression === NONE) return buf;
  throw new Error(`unsupported PMTiles compression ${compression}`);
}

/** A varint as a number (tile ids and offsets stay below 2^53). */
function varint(buf: Uint8Array, at: { pos: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    const b = buf[at.pos++];
    if (b === undefined) throw new Error("truncated PMTiles directory");
    value += (b & 0x7f) * scale;
    if (b < 0x80) return value;
    scale *= 128;
  }
}

function directory(buf: Uint8Array): Entry[] {
  const at = { pos: 0 };
  const n = varint(buf, at);
  const entries: Entry[] = [];
  let tileId = 0;
  for (let i = 0; i < n; i++) {
    tileId += varint(buf, at);
    entries.push({ tileId, offset: 0, length: 0, runLength: 0 });
  }
  for (const e of entries) e.runLength = varint(buf, at);
  for (const e of entries) e.length = varint(buf, at);
  entries.forEach((e, i) => {
    const v = varint(buf, at);
    const prev = entries[i - 1];
    e.offset = v === 0 && prev ? prev.offset + prev.length : v - 1;
  });
  return entries;
}

export class PMTilesFile {
  readonly header: Header;
  private readonly fh: FileHandle;

  private constructor(fh: FileHandle, header: Header) {
    this.fh = fh;
    this.header = header;
  }

  static async open(path: string): Promise<PMTilesFile> {
    const fh = await open(path, "r");
    const buf = new Uint8Array(HEADER_BYTES);
    await fh.read(buf, 0, HEADER_BYTES, 0);
    return new PMTilesFile(fh, bytesToHeader(buf.buffer));
  }

  private async bytes(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    await this.fh.read(buf, 0, length, offset);
    return buf;
  }

  /** The metadata JSON (layers, attribution, …). */
  async metadata(): Promise<unknown> {
    const h = this.header;
    const raw = await this.bytes(h.jsonMetadataOffset, h.jsonMetadataLength);
    return JSON.parse(
      new TextDecoder().decode(decompress(raw, h.internalCompression)),
    );
  }

  /** Every tile, in tile id order (by zoom, then along the Hilbert curve); repeated runs once per position. */
  async *tiles(): AsyncGenerator<TileData> {
    const h = this.header;
    const dir = async (offset: number, length: number) =>
      directory(
        decompress(await this.bytes(offset, length), h.internalCompression),
      );
    const walk = async function* (
      this: PMTilesFile,
      entries: Entry[],
    ): AsyncGenerator<TileData> {
      for (const e of entries) {
        if (e.runLength === 0) {
          yield* walk.call(
            this,
            await dir(h.leafDirectoryOffset + e.offset, e.length),
          );
          continue;
        }
        const data = decompress(
          await this.bytes(h.tileDataOffset + e.offset, e.length),
          h.tileCompression,
        );
        for (let i = 0; i < e.runLength; i++) {
          const [z, x, y] = tileIdToZxy(e.tileId + i);
          yield { z, x, y, data };
        }
      }
    };
    yield* walk.call(
      this,
      await dir(h.rootDirectoryOffset, h.rootDirectoryLength),
    );
  }

  async close(): Promise<void> {
    await this.fh.close();
  }
}
