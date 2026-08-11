import { useEffect, useState } from "react";
import { api } from "../api.js";

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
        Every create, delete, and AdsPower fetch runs as a job the bridge picks up. See the
        Profiles tab for the resulting fleet.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
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
                <td>{new Date(j.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!jobs.length && (
              <tr>
                <td colSpan={4} className="tag-warn">
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
