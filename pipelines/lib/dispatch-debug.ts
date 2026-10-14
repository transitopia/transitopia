// The dispatcher's debug output (CLAUDE.md → Dispatcher notes), switched on from the environment
// wherever it dispatches (the builds and the server):
//   DISPATCH_DEBUG=1                      the waits-for chain at the first deadlock broken
//   DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>   trace one train

import type { DispatchDebug } from "@transitopia/transit-core/dispatch/dispatch.ts";

export function dispatchDebugFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DispatchDebug {
  const run = env["DISPATCH_TRACE"];
  return {
    chains: Boolean(env["DISPATCH_DEBUG"]),
    trace:
      run ?
        {
          run,
          from: Number(env["DISPATCH_TRACE_FROM"] || 0),
          to: Number(env["DISPATCH_TRACE_TO"] || 0),
        }
      : undefined,
  };
}
