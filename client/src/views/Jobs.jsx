import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Jobs() {
  const [profiles, setProfiles] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [sel, setSel] = useState(new Set());
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null);

  async function refresh() {
    setProfiles(await api.profiles());
    setJobs(await api.jobs());
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  function toggle(id) {
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function del() {
    if (confirm.trim() !== "DELETE" || !sel.size) return;
    try {
      const r = await api.delProfiles([...sel]);
      setMsg(`Queued delete job #${r.job_id} — ${r.queued} profiles. Bridge will remove them.`);
      setSel(new Set());
      setConfirm("");
      refresh();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
  }

  const created = profiles.filter((p) => p.status === "created");

  return (
    <>
      <div className="card">
        <p className="eyebrow">03 / fleet</p>
        <h2>Profiles</h2>
        <div style={{ marginBottom: 12 }}>
          <a href={api.exportUrl()} target="_blank" rel="noreferrer">
            <button className="ghost">Export CSV</button>
          </a>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Group</th>
                <th>Proxy</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.status === "created" && (
                      <input
                        type="checkbox"
                        checked={sel.has(p.id)}
                        onChange={() => toggle(p.id)}
                        style={{ width: "auto" }}
                      />
                    )}
                  </td>
                  <td>{p.name}</td>
                  <td>{p.group_name || "—"}</td>
                  <td>{p.host ? `${p.host}:${p.port}` : "—"}</td>
                  <td>
                    <span className={"pill " + p.status}>{p.status}</span>
                  </td>
                </tr>
              ))}
              {!profiles.length && (
                <tr>
                  <td colSpan={5} className="tag-warn">
                    none yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card risk">
        <p className="eyebrow">danger</p>
        <h2>Delete selected ({sel.size})</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div>
            <label>
              Type <b className="tag-bad">DELETE</b> to confirm
            </label>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <div style={{ flex: "0 0 200px" }}>
            <button
              className="danger"
              disabled={confirm.trim() !== "DELETE" || !sel.size}
              onClick={del}
            >
              Queue delete
            </button>
          </div>
        </div>
        <p className="hint">
          Frees the proxy back to unused when the bridge confirms removal.
          Only created profiles can be selected.
        </p>
        {msg && <div className="out">{msg}</div>}
      </div>

      <div className="card">
        <h2>Job log</h2>
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
    </>
  );
}
