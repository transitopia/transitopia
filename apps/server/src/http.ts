// Adapter from Node's http request/response to RtService.handle.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RtService } from "./rt/service.ts";

export async function serveRt(
  service: RtService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  try {
    const r = await service.handle(url.pathname, url.searchParams);
    res.writeHead(r.status, r.headers);
    res.end(req.method === "HEAD" ? undefined : r.body);
  } catch (e) {
    console.error("[rt] handler error:", e);
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Internal error" }));
  }
}
