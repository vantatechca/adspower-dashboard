import { useEffect, useState } from "react";
import { api } from "../api.js";

// what actually happened, pulled from the same result the bridge posted —
// so a stuck-looking reassignment/create shows its real AdsPower error
// instead of just "done" or "error" with no explanation
function jobDetail(j) {
  const r = j.result;
  if (!r) return j.status === "pending" || j.status === "running" ? "waiting on the bridge…" : "—";
  if (r.error) return `error: ${r.error}`;
  if (r.summary) {
    const s = r.summary;
    const parts = [`${s.newProfile ?? 0} new`, `${s.updatedProfile ?? 0} updated`];
    if (s.matchedProxy || s.addedProxy)
      parts.push(`proxies: ${s.matchedProxy ?? 0} matched, ${s.addedProxy ?? 0} added`);
    if (s.freedProxy) parts.push(`${s.freedProxy} freed`);
    if (s.failed) parts.push(`${s.failed} failed${s.errors?.[0] ? ` (${s.errors[0]})` : ""}`);
    return parts.join(" · ");
  }
  if (Array.isArray(r.results)) {
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.length - ok;
    const firstErr = r.results.find((x) => !x.ok && x.msg)?.msg;
    if (!r.results.length) return "no items";
    return `${ok} ok, ${failed} failed` + (firstErr ? ` — ${firstErr}` : "");
  }
  return "—";
}

export default function Jobs() {
  const [jobs, setJobs] = useState([]);

  async function refresh() {
    setJobs(await api.jobs());
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card">
      <p className="eyebrow">04 / activity</p>
      <h2>Job log</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Every create, delete, reassign, connectivity test, and AdsPower fetch runs as a job the
        bridge picks up. See
        the Profiles tab for the resulting fleet. The Result column shows what the bridge/AdsPower
        actually reported — hover a row for the full raw result. A job stuck on "pending" means
        the bridge isn't polling (check it's online and running the latest code); "running" with
        no update for a while usually means it crashed mid-job.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Status</th>
              <th>Result</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const detail = jobDetail(j);
              return (
                <tr key={j.id}>
                  <td>{j.id}</td>
                  <td>{j.type}</td>
                  <td>
                    <span
                      className={
                        j.status === "done"
                          ? "tag-ok"
                          : j.status === "error"
                          ? "tag-bad"
                          : "tag-warn"
                      }
                    >
                      {j.status}
                    </span>
                  </td>
                  <td
                    className={j.status === "error" ? "tag-bad" : undefined}
                    title={JSON.stringify(j.result ?? {}, null, 2)}
                  >
                    {detail}
                  </td>
                  <td>{new Date(j.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
            {!jobs.length && (
              <tr>
                <td colSpan={5} className="tag-warn">
                  no jobs
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
