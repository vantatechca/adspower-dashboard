import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export default function Proxies() {
  const [stats, setStats] = useState({ unused: 0, used: 0 });
  const [view, setView] = useState("unused");
  const [rows, setRows] = useState([]);
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const fileRef = useRef();

  async function refresh() {
    setStats(await api.stats());
    setRows(await api.proxies(view));
  }
  useEffect(() => {
    refresh();
  }, [view]);

  async function upload() {
    if (!text.trim()) return;
    setBusy(true);
    setMsg("Parsing…");
    try {
      const r = await api.upload(text, source);
      let m = `Added ${r.added} · ${r.duplicates} dupes`;
      if (r.aiRecovered) m += ` · ${r.aiRecovered} via AI`;
      if (r.unparsed) m += ` · ${r.unparsed} unparsed`;
      setMsg(m);
      setText("");
      refresh();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setBusy(false);
  }

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText((t) => (t ? t + "\n" : "") + reader.result);
    reader.readAsText(f);
    if (!source) setSource(f.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  }

  async function del(id) {
    await api.delProxy(id);
    refresh();
  }

  async function sync() {
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
          if (s) {
            setSyncMsg(
              `AdsPower returned ${s.returned} profile(s) — ` +
                `${s.newProfile} new, ${s.updatedProfile} updated · ` +
                `proxies: ${s.matchedProxy} matched, ${s.addedProxy} added` +
                (s.noProxyInfo ? ` · ${s.noProxyInfo} had no proxy info` : "") +
                (s.failed
                  ? ` · ${s.failed} failed${s.errors?.length ? ` (${s.errors[0]})` : ""}`
                  : "") +
                (s.returned === 0
                  ? ". AdsPower reported no profiles — check AdsPower is open with the Local API enabled and that profiles exist."
                  : ". See the Jobs tab for the imported profiles.")
            );
          } else {
            setSyncMsg("Synced with AdsPower — counts updated. See the Jobs tab for profiles.");
          }
          done = true;
        } else if (j.status === "error") {
          setSyncMsg("Sync error — is the bridge online and AdsPower running?");
          done = true;
        } else if (j.status === "pending" && i > 4) {
          setSyncMsg("Bridge hasn't picked it up — check it's online.");
        } else {
          setSyncMsg("Fetching profiles from AdsPower…");
        }
      }
      refresh();
    } catch (e) {
      setSyncMsg("Error: " + e.message);
    }
    setSyncing(false);
  }

  return (
    <>
      <div className="card">
        <p className="eyebrow">01 / ingest</p>
        <h2>Upload proxies</h2>
        <div className="row field">
          <div style={{ flex: "0 0 220px" }}>
            <label>Source label</label>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="oxylabs-isp / webshare"
            />
          </div>
          <div style={{ flex: "0 0 160px" }}>
            <label>From file</label>
            <input
              type="file"
              accept=".txt,.csv,.tsv"
              ref={fileRef}
              onChange={onFile}
            />
          </div>
        </div>
        <div className="field">
          <label>Paste any format — host:port:user:pass, user:pass@host:port, CSV…</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"1.2.3.4:5678:user:pass\nuser:pass@isp.oxylabs.io:8001\nsocks5://5.6.7.8:1080"}
          />
        </div>
        <button onClick={upload} disabled={busy}>
          {busy ? "Working…" : "Parse & save"}
        </button>
        {msg && <div className="out">{msg}</div>}
      </div>

      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div>
            <span className="stat">
              <b className="tag-ok">{stats.unused}</b>
              <span>unused</span>
            </span>
            <span className="stat">
              <b>{stats.used}</b>
              <span>used</span>
            </span>
          </div>
          <button className="ghost" onClick={sync} disabled={syncing}>
            {syncing ? "Fetching…" : "Fetch from AdsPower"}
          </button>
        </div>
        {syncMsg && (
          <div className="out" style={{ marginTop: 0, marginBottom: 8 }}>
            {syncMsg}
          </div>
        )}

        <div className="tabs" style={{ marginBottom: 14 }}>
          {["unused", "used"].map((v) => (
            <button
              key={v}
              className={"tab" + (view === v ? " active" : "")}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>

        <div className="scroll">
          <table>
            <thead>
              {view === "unused" ? (
                <tr>
                  <th>Host</th>
                  <th>Port</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              ) : (
                <tr>
                  <th>Profile</th>
                  <th>Host</th>
                  <th>Port</th>
                  <th>Type</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((p) =>
                view === "unused" ? (
                  <tr key={p.id}>
                    <td>{p.host}</td>
                    <td>{p.port}</td>
                    <td>{p.proxy_type}</td>
                    <td className="tag-warn">{p.source || "—"}</td>
                    <td>
                      <span
                        className="tag-bad"
                        style={{ cursor: "pointer" }}
                        onClick={() => del(p.id)}
                      >
                        del
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td>{p.profile_name || "—"}</td>
                    <td>{p.host}</td>
                    <td>{p.port}</td>
                    <td>{p.proxy_type}</td>
                  </tr>
                )
              )}
              {!rows.length && (
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
    </>
  );
}