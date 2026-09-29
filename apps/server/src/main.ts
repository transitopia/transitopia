// Standalone RT service (proxy + cache + recorder) without Vite: leave it running to collect bus
// history, or point a static build at it.
//
//   npm run server             # http://localhost:8787/rt/live

import { createServer } from 'node:http';
import rtConfig from '@transitopia/region-metro-vancouver/config/rt.json' with { type: 'json' };
import { RtService } from './rt/service.ts';
import { serveRt } from './http.ts';

const port = Number(process.env.PORT ?? rtConfig.serverPort);
const service = new RtService();
const server = createServer((req, res) => void serveRt(service, req, res));
server.listen(port, () => {
  console.log(`[rt] Listening on http://localhost:${port}/rt/live`);
  void service.start(port);
});

const shutdown = () => {
  service.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
