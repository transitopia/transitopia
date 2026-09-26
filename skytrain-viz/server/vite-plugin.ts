// Mounts the RT service at /rt/* in the Vite dev and preview servers, so `npm run dev` also polls
// and records real-time bus positions (PLAN.md §4.6). Set SKYTRAIN_RT=off to disable.

import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { RtService } from './rt/service.ts';
import { serveRt } from './http.ts';

export function rtServicePlugin(): Plugin {
  let service: RtService | undefined;
  const mount = (server: ViteDevServer | PreviewServer) => {
    if (process.env.SKYTRAIN_RT === 'off') return;
    service ??= new RtService();
    const http = server.httpServer;
    // Start once listening, so the lock advertises the real port to other processes.
    http?.once('listening', () => {
      const addr = http.address();
      void service!.start(typeof addr === 'object' && addr ? addr.port : undefined);
    });
    http?.on('close', () => service?.stop());
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/rt/')) return next();
      void serveRt(service!, req, res);
    });
  };
  return {
    name: 'skytrain-rt-service',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
