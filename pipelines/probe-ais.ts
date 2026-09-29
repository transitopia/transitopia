// Probe aisstream.io for the SeaBus fleet: record raw messages for a while, then summarise what
// the feed gives us (message types, report rates, timestamps, heading vs course, dimensions).
// Output: data/raw/ais-probe/<start>.ndjson (raw messages; no key).
//
//   npx tsx scripts/probe-ais.ts [--minutes 30]

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RAW_DIR, log } from './lib/paths.ts';
import { aisstreamApiKey } from '@transitopia/server/secrets.ts';

const FLEET: Record<string, string> = {
  '316011649': 'Burrard Beaver',
  '316014621': 'Burrard Pacific Breeze',
  '316028554': 'Burrard Otter II',
  '316042365': 'Burrard Chinook',
};
/** Burrard Inlet between Waterfront and Lonsdale Quay, with margin: [[lat, lon], [lat, lon]]. */
const BOX = [[49.27, -123.14], [49.33, -123.05]];

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1] || 30);
const key = aisstreamApiKey();
if (!key) throw new Error('AISSTREAM_API_KEY missing from the environment and .secrets');

const dir = join(RAW_DIR, 'ais-probe');
await mkdir(dir, { recursive: true });
const out = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);

interface Msg { MessageType: string; MetaData: Record<string, unknown>; Message: Record<string, Record<string, unknown>> }
const received: { at: number; msg: Msg }[] = [];
let lines: string[] = [];
const flush = async () => {
  if (!lines.length) return;
  const chunk = lines.join('');
  lines = [];
  await appendFile(out, chunk);
};

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
const done = new Promise<void>((resolve) => {
  ws.addEventListener('open', () => {
    log(`Connected; recording ${minutes} min to ${out}`);
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [BOX], FiltersShipMMSI: Object.keys(FLEET) }));
  });
  ws.addEventListener('message', async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString('utf8');
    const at = Date.now();
    let msg: Msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log(`Non-JSON message: ${text.slice(0, 200)}`);
      return;
    }
    if (!('MetaData' in msg)) log(`Server message: ${text.slice(0, 300)}`);
    received.push({ at, msg });
    lines.push(JSON.stringify({ at, ...msg }) + '\n');
  });
  ws.addEventListener('error', (ev) => log(`WebSocket error: ${(ev as ErrorEvent).message ?? 'unknown'}`));
  ws.addEventListener('close', (ev) => {
    log(`Closed: code ${ev.code} ${ev.reason}`);
    resolve();
  });
});
const flusher = setInterval(() => void flush(), 5000);
const stop = setTimeout(() => ws.close(), minutes * 60_000);
await done;
clearTimeout(stop);
clearInterval(flusher);
await flush();

// Summary.
const byMmsi = new Map<string, { at: number; msg: Msg }[]>();
for (const r of received) {
  const m = String(r.msg.MetaData?.MMSI ?? '?');
  (byMmsi.get(m) ?? byMmsi.set(m, []).get(m)!).push(r);
}
log(`${received.length} messages`);
const sample = received.find((r) => r.msg.MetaData);
if (sample) log(`MetaData sample: ${JSON.stringify(sample.msg.MetaData)}`);
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
for (const [mmsi, list] of byMmsi) {
  const types = new Map<string, number>();
  for (const r of list) types.set(r.msg.MessageType, (types.get(r.msg.MessageType) ?? 0) + 1);
  const pos = list.filter((r) => r.msg.MessageType === 'PositionReport').map((r) => r.msg.Message.PositionReport!);
  const times = list.filter((r) => r.msg.MessageType === 'PositionReport').map((r) => r.at);
  const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000).sort((a, b) => a - b);
  const q = (p: number) => gaps.length ? gaps[Math.floor(p * (gaps.length - 1))]!.toFixed(1) : '-';
  const moving = pos.filter((p) => Number(p.Sog) > 3 && Number(p.TrueHeading) < 360);
  const flips = moving.filter((p) => angle(Number(p.Cog), Number(p.TrueHeading)) > 90).length;
  log(`${mmsi} ${FLEET[mmsi] ?? '(not in fleet)'}: ${[...types].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  log(`  position gaps s p10/p50/p90/max: ${q(0.1)}/${q(0.5)}/${q(0.9)}/${q(1)}; moving fixes ${moving.length}, heading opposite course in ${flips}`);
  const statics = list.find((r) => r.msg.MessageType === 'ShipStaticData');
  if (statics) log(`  static: ${JSON.stringify(statics.msg.Message.ShipStaticData)}`);
  if (pos.length) log(`  last position report: ${JSON.stringify(pos[pos.length - 1])}`);
}
