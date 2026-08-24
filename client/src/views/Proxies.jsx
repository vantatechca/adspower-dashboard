import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

function fullAddress(p) {
  const base = `${p.host}:${p.port}`;
  return p.username ? `${base}:${p.username}:${p.password}` : base;
}

export default function Proxies() {
  const [stats, setStats] = useState({ unused: 0, used: 0, failed: 0 });
  const [view, setView] = useState("unused");
  const [rows, setRows] = useState([]);
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [delBusy, setDelBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState(null);
  const fileRef = useRef();

  function copyAddr(id, addr) {
    navigator.clipboard?.writeText(addr).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
    });
  }

  function toggleSel(id) {
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function refresh() {
    setStats(await api.stats());
    setRows(await api.proxies(view));
  }
  useEffect(() => {
    setSel(new Set());
    refresh();
  }, [view]);

  async function upload() {
    if (!text.trim()) return;
    setBusy(true);
    setMsg("Parsing…");
    try {
      const r = await api.upload(text, source);
      let m = `Added ${r.added} · ${r.replaced} replaced (already-saved matches updated)`;
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

  async function delSelected() {
    if (!sel.size) return;
    if (!confirm(`Delete ${sel.size} selected proxy/proxies? This can't be undone.`)) return;
    setDelBusy(true);
    try {
      await api.delProxiesBatch([...sel]);
      setSel(new Set());
      refresh();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setDelBusy(false);
  }

  async function reconcile() {
    setReconciling(true);
    setReconcileMsg(null);
    try {
      const r = await api.reconcileProxies();
      setReconcileMsg(
        r.freed
          ? `Freed ${r.freed} proxy/proxies that were reserved but not actually tied to any profile.`
          : "Nothing to free — no stuck proxies found."
      );
      refresh();
    } catch (e) {
      setReconcileMsg("Error: " + e.message);
    }
    setReconciling(false);
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
        <p className="hint">
          Re-uploading a host:port:user already saved updates its password/type/source
          in place — the newest upload wins. AdsPower profiles already using it aren't
          touched.
        </p>
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
            <span className="stat">
              <b className="tag-bad">{stats.failed}</b>
              <span>failed</span>
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="ghost"
              onClick={reconcile}
              disabled={reconciling}
              title="Free proxies stuck 'used' with no profile actually pointing at them — e.g. after a reassignment that didn't finish cleanly"
            >
              {reconciling ? "Checking…" : "Free stuck proxies"}
            </button>
            <button className="ghost" onClick={sync} disabled={syncing}>
              {syncing ? "Fetching…" : "Fetch from AdsPower"}
            </button>
          </div>
        </div>
        {reconcileMsg && (
          <div className="out" style={{ marginTop: 0, marginBottom: 8 }}>
            {reconcileMsg}
          </div>
        )}
        {syncMsg && (
          <div className="out" style={{ marginTop: 0, marginBottom: 8 }}>
            {syncMsg}
          </div>
        )}

        <div
          className="tabs"
          style={{ marginBottom: 14, justifyContent: "space-between", display: "flex" }}
        >
          <div className="tabs" style={{ marginBottom: 0 }}>
            {["unused", "used", "failed"].map((v) => (
              <button
                key={v}
                className={"tab" + (view === v ? " active" : "")}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>
          {view !== "used" && sel.size > 0 && (
            <button className="danger" onClick={delSelected} disabled={delBusy}>
              {delBusy ? "Deleting…" : `Delete selected (${sel.size})`}
            </button>
          )}
        </div>

        <div className="scroll">
          <table>
            <thead>
              {view === "unused" && (
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={rows.length > 0 && sel.size === rows.length}
                      onChange={(e) =>
                        setSel(e.target.checked ? new Set(rows.map((p) => p.id)) : new Set())
                      }
                      style={{ width: "auto" }}
                    />
                  </th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Fails</th>
                  <th></th>
                </tr>
              )}
              {view === "used" && (
                <tr>
                  <th>Profile</th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Fails</th>
                </tr>
              )}
              {view === "failed" && (
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={rows.length > 0 && sel.size === rows.length}
                      onChange={(e) =>
                        setSel(e.target.checked ? new Set(rows.map((p) => p.id)) : new Set())
                      }
                      style={{ width: "auto" }}
                    />
                  </th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Fails</th>
                  <th>Last error</th>
                  <th>Last failed</th>
                  <th></th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((p) => {
                const addr = fullAddress(p);
                const addrCell = (
                  <td
                    style={{ cursor: "pointer" }}
                    title={copiedId === p.id ? undefined : `${addr} — click to copy`}
                    onClick={() => copyAddr(p.id, addr)}
                  >
                    {copiedId === p.id ? "copied ✓" : addr}
                  </td>
                );
                const failsCell = (
                  <td className={p.fail_count > 0 ? "tag-bad" : ""}>
                    {p.fail_count > 0 ? p.fail_count : "—"}
                  </td>
                );
                const checkCell = (
                  <td>
                    <input
                      type="checkbox"
                      checked={sel.has(p.id)}
                      onChange={() => toggleSel(p.id)}
                      style={{ width: "auto" }}
                    />
                  </td>
                );
                if (view === "unused")
                  return (
                    <tr key={p.id}>
                      {checkCell}
                      {addrCell}
                      <td>{p.proxy_type}</td>
                      <td className="tag-warn">{p.source || "—"}</td>
                      {failsCell}
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
                  );
                if (view === "used")
                  return (
                    <tr key={p.id}>
                      <td>{p.profile_name || "—"}</td>
                      {addrCell}
                      <td>{p.proxy_type}</td>
                      {failsCell}
                    </tr>
                  );
                return (
                  <tr key={p.id}>
                    {checkCell}
                    {addrCell}
                    <td>{p.proxy_type}</td>
                    <td className="tag-warn">{p.source || "—"}</td>
                    <td className="tag-bad">{p.fail_count}</td>
                    <td className="tag-bad" title={p.last_error}>
                      {p.last_error ? p.last_error.slice(0, 48) : "—"}
                    </td>
                    <td>
                      {p.last_failed_at
                        ? new Date(p.last_failed_at).toLocaleString()
                        : "—"}
                    </td>
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
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="tag-warn">
                    {view === "failed" ? "no failures recorded" : "none yet"}
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