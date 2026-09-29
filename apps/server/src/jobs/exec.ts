// Run a command (pipelines, rclone) and collect its output; the server's log gets each line.

import { spawn } from "node:child_process";

export async function run(
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    log?: (line: string) => void;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      tail = (tail + text).slice(-20_000);
      for (const line of text.split("\n")) if (line.trim()) opts.log?.(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ?
        resolve(tail)
      : reject(
          new Error(
            `${cmd} ${args[0] ?? ""} exited with ${code}:\n${tail.slice(-2000)}`,
          ),
        ),
    );
  });
}
