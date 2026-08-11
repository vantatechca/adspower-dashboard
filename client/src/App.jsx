import { useEffect, useState } from "react";
import { api, setToken, getToken } from "./api.js";
import Proxies from "./views/Proxies.jsx";
import Create from "./views/Create.jsx";
import Jobs from "./views/Jobs.jsx";

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [tokenReq, setTokenReq] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());
  const [tab, setTab] = useState("proxies");
  const [ai, setAi] = useState(false);
  const [bridge, setBridge] = useState({ online: false, host: null, lastSeen: null });

  useEffect(() => {
    api.health().then((h) => {
      setTokenReq(h.tokenRequired);
      setAi(h.ai);
      setReady(true);
    });
  }, []);

  async function tryAuth() {
    try {
      await api.stats();
      setAuthed(true);
    } catch (e) {
      setAuthed(false);
    }
  }
  useEffect(() => {
    if (ready) tryAuth();
  }, [ready]);

  // bridge heartbeat poll (no-ops on 401 before token entered)
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.bridgeStatus().then((s) => alive && setBridge(s)).catch(() => {});
    poll();
    const t = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed]);

  if (!ready) return <div className="center">loading…</div>;

  if (tokenReq && !authed) {
    return (
      <div className="center">
        <div className="card gate">
          <p className="eyebrow">access</p>
          <h2>Enter app token</h2>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="APP_TOKEN"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={submit}>Unlock</button>
          </div>
        </div>
      </div>
    );
    function submit() {
      setToken(tokenInput.trim());
      tryAuth();
    }
  }

  return (
    <div className="wrap">
      <header>
        <h1>
          AdsPower <span>Console</span>
        </h1>
        <div className="badge">
          <span title={bridge.host ? `host: ${bridge.host}` : "no bridge seen yet"}>
            bridge{" "}
            <b className={bridge.online ? "up" : "down"}>
              {bridge.online ? "online" : "offline"}
            </b>
          </span>
          <span style={{ marginLeft: 14 }}>
            ai <b className={ai ? "up" : "down"}>{ai ? "on" : "off"}</b>
          </span>
        </div>
      </header>

      <div className="tabs">
        {["proxies", "create", "jobs"].map((t) => (
          <button
            key={t}
            className={"tab" + (tab === t ? " active" : "")}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "proxies" && <Proxies />}
      {tab === "create" && <Create />}
      {tab === "jobs" && <Jobs />}
    </div>
  );
}
