import { useStatus } from "./api.ts";
import { card } from "./styles.ts";

/** The server's health, request budget, poller and recent jobs. */
export function Status() {
  const { data: s } = useStatus();
  if (!s) return null;
  return (
    <section className={`${card} flex flex-col gap-2`}>
      <h2 className="text-base font-semibold">
        Server{" "}
        <span
          className={
            s.health.ok ?
              "text-green-700 dark:text-green-400"
            : "text-red-700 dark:text-red-400"
          }>
          {s.health.ok ? "healthy" : "unhealthy"}
        </span>
      </h2>
      <ul className="text-sm">
        {Object.entries(s.health.checks).map(([k, c]) => (
          <li key={k}>
            {c.ok ? "✓" : "✗"} {k}
            {c.detail ? `: ${c.detail}` : ""}
          </li>
        ))}
        {Object.entries(s.rt.providers).map(([id, p]) => (
          <li key={id}>
            {p.name}:{" "}
            {p.polling ?
              <>
                {p.budget.used24h} of {p.budget.cap} requests in the last 24 h
                {p.budget.capped ? " (cap reached)" : ""}; positions every{" "}
                {p.budget.intervalsS.positions} s; {p.vehicles} drawn vehicles
                in the last poll
                {p.lastSnapshotAgeS !== null ?
                  `, ${Math.round(p.lastSnapshotAgeS)} s ago`
                : ""}
              </>
            : "not polling"}
          </li>
        ))}
        <li>
          {s.rt.leader ? "Leader" : "Follower"}
          {s.rt.ais ?
            `; AIS ${s.rt.ais.connected ? "connected" : "disconnected"}`
          : ""}
        </li>
      </ul>
      <details>
        <summary className="cursor-pointer text-sm">Recent jobs</summary>
        <table className="mt-2 w-full text-left text-xs">
          <tbody>
            {s.jobs.map((j) => (
              <tr key={`${j.job}:${j.key}`} className="align-top">
                <td className="pr-2">{j.job}</td>
                <td className="pr-2">{j.key}</td>
                <td
                  className={`pr-2 ${j.status === "failed" ? "text-red-700 dark:text-red-400" : ""}`}>
                  {j.status}
                </td>
                <td className="pr-2">{j.started_at.toLocaleString()}</td>
                <td className="whitespace-pre-wrap">
                  {j.error?.split("\n")[0] ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
