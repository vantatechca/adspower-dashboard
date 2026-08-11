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
        <div style={{ marginBottom: 16 }}>
          <span className="stat">
            <b className="tag-ok">{stats.unused}</b>
            <span>unused</span>
          </span>
          <span className="stat">
            <b>{stats.used}</b>
            <span>used</span>
          </span>
        </div>

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
