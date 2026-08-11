import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Create() {
  const [pool, setPool] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [prefix, setPrefix] = useState("Profile");
  const [start, setStart] = useState(1);
  const [group, setGroup] = useState("");
  const [os, setOs] = useState("random");
  const [count, setCount] = useState(10);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [takenNames, setTakenNames] = useState(new Set());

  async function loadPool() {
    setPool(await api.proxies("unused"));
    try {
      const rows = await api.profiles();
      // names already in use by live (non-deleted) profiles
      setTakenNames(
        new Set(rows.filter((p) => p.status !== "deleted").map((p) => p.name))
      );
    } catch (e) {
      /* ignore — warning is best-effort */
    }
  }
  useEffect(() => {
    loadPool();
  }, []);

  // names this batch would create, and how many collide with existing profiles
  const plannedNames = Array.from({ length: selected.size }, (_, i) =>
    `${prefix} ${+start + i}`.trim()
  );
  const dupCount = plannedNames.filter((n) => takenNames.has(n)).length;

  function toggle(id) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function randomN() {
    const ids = [...pool].sort(() => Math.random() - 0.5).slice(0, count).map((p) => p.id);
    setSelected(new Set(ids));
  }

  async function suggestN() {
    const picks = await api.suggest(count);
    setSelected(new Set(picks.map((p) => p.id)));
    setMsg(`Suggested ${picks.length} subnet-diverse proxies.`);
  }

  async function plan() {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setMsg("Queuing…");
    try {
      const r = await api.plan({ prefix, start: +start, group, os, proxy_ids: ids });
      setMsg(
        `Queued job #${r.job_id} — ${r.planned} profiles planned. Run the local bridge to create them in AdsPower.`
      );
      setSelected(new Set());
      loadPool();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setBusy(false);
  }

  return (
    <>
      <div className="card">
        <p className="eyebrow">02 / plan</p>
        <h2>Create profiles</h2>

        <div className="row field">
          <div>
            <label>Name prefix</label>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <div style={{ flex: "0 0 110px" }}>
            <label>Start no.</label>
            <input value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label>Group</label>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="blank = ungrouped"
            />
          </div>
        </div>

        <div className="row field">
          <div style={{ flex: "0 0 220px" }}>
            <label>Operating system</label>
            <select value={os} onChange={(e) => setOs(e.target.value)}>
              <option value="random">Random (mix Win + Mac)</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
            </select>
          </div>
          <div style={{ flex: 1, alignSelf: "flex-end" }}>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              User-agent, Chrome kernel & WebGL vendor/renderer are randomized per
              profile to match the chosen OS.
            </span>
          </div>
        </div>

        <div className="row field" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: "0 0 120px" }}>
            <label>Pick count</label>
            <input value={count} onChange={(e) => setCount(+e.target.value || 0)} />
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <button className="ghost" onClick={randomN}>
              Random {count}
            </button>
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <button className="ghost" onClick={suggestN}>
              Smart-suggest {count}
            </button>
          </div>
          <div style={{ flex: 1, textAlign: "right" }}>
            <b className="tag-ok" style={{ fontFamily: "var(--mono)" }}>
              {selected.size}
            </b>{" "}
            <span style={{ color: "var(--muted)", fontSize: 12 }}>selected</span>
          </div>
        </div>

        {selected.size > 0 && (
          <p className="hint" style={{ marginTop: 0 }}>
            Will name them{" "}
            <b style={{ fontFamily: "var(--mono)" }}>
              {`${prefix} ${+start}`.trim()}
            </b>{" "}
            …{" "}
            <b style={{ fontFamily: "var(--mono)" }}>
              {`${prefix} ${+start + selected.size - 1}`.trim()}
            </b>
            .
          </p>
        )}
        {dupCount > 0 && (
          <div className="out" style={{ borderColor: "var(--bad, #e5484d)" }}>
            ⚠ {dupCount} of these name(s) already exist on live profiles (e.g.{" "}
            {plannedNames.find((n) => takenNames.has(n))}). Change the prefix or the start
            number to avoid duplicates.
          </div>
        )}
        <button onClick={plan} disabled={busy || !selected.size}>
          {busy ? "…" : `Plan & queue ${selected.size} profiles`}
        </button>
        {msg && <div className="out">{msg}</div>}
        <p className="hint">
          Planning writes to the DB and queues a job. The local bridge turns
          queued jobs into real AdsPower profiles.
        </p>
      </div>

      <div className="card">
        <h2>Unused proxies ({pool.length})</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Host</th>
                <th>Port</th>
                <th>Type</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {pool.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <input
                      type="checkbox"
                      readOnly
                      checked={selected.has(p.id)}
                      style={{ width: "auto" }}
                    />
                  </td>
                  <td>{p.host}</td>
                  <td>{p.port}</td>
                  <td>{p.proxy_type}</td>
                  <td className="tag-warn">{p.source || "—"}</td>
                </tr>
              ))}
              {!pool.length && (
                <tr>
                  <td colSpan={5} className="tag-warn">
                    no unused proxies — upload some first
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
