import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const OS_LABEL = { windows: "Windows", macos: "macOS" };

export default function Fleet() {
  const [profiles, setProfiles] = useState([]);
  const [sel, setSel] = useState(new Set());
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState("all"); // all | created | deleted
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [autoSync, setAutoSync] = useState(false);
  const syncingRef = useRef(false);

  async function refresh() {
    try {
      setProfiles(await api.profiles());
    } catch (e) {
      /* transient — keep last list */
    }
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // optional periodic reconcile with AdsPower
  useEffect(() => {
    if (!autoSync) return;
    const t = setInterval(() => sync(), 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync]);

  function toggle(id) {
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function sync() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncMsg("Queued — waiting for the bridge…");
    try {
      const { job_id } = await api.sync();
      let done = false;
      for (let i = 0; i < 40 && !done; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const jobs = await api.jobs();
        const j = jobs.find((x) => x.id === job_id);
        if (!j) continue;
        if (j.status === "done") {
          const s = j.result?.summary;
          setSyncMsg(
            s
              ? `AdsPower returned ${s.returned} profile(s) — ${s.newProfile} new, ${s.updatedProfile} updated` +
                  (s.failed ? ` · ${s.failed} failed` : "")
              : "Synced with AdsPower."
          );
          done = true;
        } else if (j.status === "error") {
          setSyncMsg("Sync error — is the bridge online and AdsPower running?");
          done = true;
        }
      }
      refresh();
    } catch (e) {
      setSyncMsg("Error: " + e.message);
    }
    setSyncing(false);
    syncingRef.current = false;
  }

  async function del() {
    if (confirm.trim() !== "DELETE" || !sel.size) return;
    try {
      const r = await api.delProfiles([...sel]);
      setMsg(`Queued delete job #${r.job_id} — ${r.queued} profiles. The bridge will remove them.`);
      setSel(new Set());
      setConfirm("");
      refresh();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
  }

  const created = profiles.filter((p) => p.status === "created");
  const shown =
    filter === "all" ? profiles : profiles.filter((p) => p.status === filter);
  const counts = profiles.reduce((a, p) => ((a[p.status] = (a[p.status] || 0) + 1), a), {});

  return (
    <>
      <div className="card">
        <p className="eyebrow">03 / fleet</p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0 }}>Profiles ({profiles.length})</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label
              style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--muted)" }}
            >
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(e) => setAutoSync(e.target.checked)}
                style={{ width: "auto" }}
              />
              auto-fetch (60s)
            </label>
            <button className="ghost" onClick={sync} disabled={syncing}>
              {syncing ? "Fetching…" : "Fetch from AdsPower"}
            </button>
            <a href={api.exportUrl()} target="_blank" rel="noreferrer">
              <button className="ghost">Export CSV</button>
            </a>
          </div>
        </div>

        <div style={{ margin: "6px 0 12px" }}>
          <span className="stat">
            <b className="tag-ok">{counts.created || 0}</b>
            <span>created</span>
          </span>
          <span className="stat">
            <b className="tag-warn">{counts.planned || 0}</b>
            <span>planned</span>
          </span>
          <span className="stat">
            <b className="tag-bad">{counts.deleted || 0}</b>
            <span>deleted</span>
          </span>
          {counts.failed ? (
            <span className="stat">
              <b className="tag-bad">{counts.failed}</b>
              <span>failed</span>
            </span>
          ) : null}
        </div>

        {syncMsg && (
          <div className="out" style={{ marginTop: 0, marginBottom: 10 }}>
            {syncMsg}
          </div>
        )}

        <div className="tabs" style={{ marginBottom: 12 }}>
          {["all", "created", "deleted"].map((f) => (
            <button
              key={f}
              className={"tab" + (filter === f ? " active" : "")}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    title="Select all created"
                    checked={created.length > 0 && sel.size === created.length}
                    onChange={(e) =>
                      setSel(e.target.checked ? new Set(created.map((p) => p.id)) : new Set())
                    }
                    style={{ width: "auto" }}
                  />
                </th>
                <th>Name</th>
                <th>Device</th>
                <th>Group</th>
                <th>Proxy address</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
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
                  <td>{OS_LABEL[p.os] || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td>{p.group_name || "—"}</td>
                  <td style={{ fontFamily: "var(--mono)" }}>
                    {p.host ? `${p.host}:${p.port}` : "—"}
                  </td>
                  <td>
                    <span className={"pill " + p.status}>{p.status}</span>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="tag-warn">
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
          Frees the proxy back to unused when the bridge confirms removal. Only created
          profiles can be selected.
        </p>
        {msg && <div className="out">{msg}</div>}
      </div>
    </>
  );
}
