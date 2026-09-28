import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { RtService } from '../server/rt/service.ts';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

function emptyFeed(): Uint8Array {
  return FeedMessage.encode(
    FeedMessage.create({ header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) }, entity: [] }),
  ).finish();
}

describe('RtService', () => {
  let dir: string | undefined;
  let service: RtService | undefined;

  afterEach(async () => {
    service?.stop();
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves many concurrent clients from one upstream poll', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-test-'));
    const upstream = vi.fn(async (url: string | URL) => {
      expect(String(url)).toMatch(/gtfsapi\.translink\.ca/);
      return new Response(new Blob([emptyFeed() as Uint8Array<ArrayBuffer>]), { status: 200 });
    });
    vi.stubGlobal('fetch', upstream);

    service = new RtService({ historyDir: dir, record: false, log: () => {}, apiKey: 'test-key', dispatch: false });
    await service.start(0);
    // Let the first positions + trip-updates polls complete.
    await vi.waitFor(() => expect(service!.liveResponse().snapshot).not.toBeNull());

    const before = upstream.mock.calls.length;
    const responses = await Promise.all(Array.from({ length: 100 }, () => service!.handle('/rt/live', new URLSearchParams())));
    expect(upstream.mock.calls.length).toBe(before);
    expect(before).toBe(2);
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(r.headers['Cache-Control']).toMatch(/max-age=10/);
      // The key must never appear in responses.
      expect(String(r.body)).not.toContain('test-key');
    }
  });

  it('reports no key without calling upstream', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-test-'));
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    service = new RtService({ historyDir: dir, record: false, log: () => {}, apiKey: null, dispatch: false });
    await service.start(0);
    const r = await service.handle('/rt/live', new URLSearchParams());
    const body = JSON.parse(String(r.body));
    expect(body.snapshot).toBeNull();
    expect(body.stale).toBe(true);
    expect(body.error).toMatch(/API key/);
    expect(upstream).not.toHaveBeenCalled();
    // Live dispatch is off here: no pointer, and its endpoints say so.
    expect(body.dispatch).toBeUndefined();
    expect((await service.handle('/rt/dispatch', new URLSearchParams())).status).toBe(404);
  });
});
