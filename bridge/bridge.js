import "dotenv/config";
import os from "os";

const CLOUD = (process.env.CLOUD_URL || "").replace(/\/$/, "");
const TOKEN = process.env.BRIDGE_TOKEN || "";
const AP = process.env.ADSPOWER_API || "http://local.adspower.net:50325";
const POLL = (+process.env.POLL_SECONDS || 5) * 1000;
const AP_RATE = 1100; // AdsPower: 1 req/sec
const HOST = os.hostname();

if (!CLOUD || !TOKEN) {
  console.error("Set CLOUD_URL and BRIDGE_TOKEN in bridge/.env");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cloud(method, path, body) {
  const res = await fetch(CLOUD + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-token": TOKEN,
      "x-bridge-host": HOST,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`cloud ${res.status}`);
  return res.json();
}

async function apPost(path, body) {
  const res = await fetch(AP + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function resolveGroupId(name) {
  name = (name || "").trim();
  if (!name) return "0";
  const res = await fetch(
    `${AP}/api/v1/group/list?page=1&page_size=100`
  ).then((r) => r.json());
  const hit = (res?.data?.list || []).find((g) => g.group_name === name);
  if (hit) return hit.group_id;
  const made = await apPost("/api/v1/group/create", { group_name: name });
  return made?.data?.group_id || "0";
}

async function runCreate(job) {
  const items = job.payload.items || [];
  const results = [];
  const groupCache = {};
  for (const it of items) {
    const g = it.group || "";
    if (!(g in groupCache)) groupCache[g] = await resolveGroupId(g);
    const px = it.proxy || {};
    const payload = {
      name: it.name,
      group_id: groupCache[g],
      user_proxy_config: {
        proxy_soft: "other",
        proxy_type: px.type || "http",
        proxy_host: px.host,
        proxy_port: px.port,
        proxy_user: px.user || "",
        proxy_password: px.pass || "",
      },
      fingerprint_config: {
        automatic_timezone: "1",
        language: ["en-US"],
        webrtc: "proxy",
      },
    };
    try {
      const r = await apPost("/api/v1/user/create", payload);
      if (r.code === 0)
        results.push({ profile_id: it.profile_id, ok: true, adspower_user_id: r.data.id });
      else results.push({ profile_id: it.profile_id, ok: false, msg: r.msg });
    } catch (e) {
      results.push({ profile_id: it.profile_id, ok: false, msg: e.message });
    }
    await sleep(AP_RATE);
  }
  return results;
}

async function runDelete(job) {
  const items = job.payload.items || [];
  const results = [];
  // delete supports up to 100 ids per call
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    try {
      const r = await apPost("/api/v1/user/delete", {
        user_ids: chunk.map((c) => c.adspower_user_id),
      });
      const ok = r.code === 0;
      chunk.forEach((c) =>
        results.push({ profile_id: c.profile_id, ok, msg: ok ? "" : r.msg })
      );
    } catch (e) {
      chunk.forEach((c) =>
        results.push({ profile_id: c.profile_id, ok: false, msg: e.message })
      );
    }
    await sleep(AP_RATE);
  }
  return results;
}

async function runSync() {
  const profiles = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${AP}/api/v1/user/list?page=${page}&page_size=100`
    ).then((r) => r.json());
    if (res?.code !== 0) {
      console.error(
        `[sync] AdsPower user/list error (page ${page}):`,
        res?.msg || JSON.stringify(res)
      );
      break;
    }
    const list = res?.data?.list || [];
    if (page === 1)
      console.log(`[sync] AdsPower reports ${res?.data?.page?.count ?? list.length} profile(s)`);
    if (!list.length) break;
    for (const p of list) {
      const cfg = p.user_proxy_config || {};
      profiles.push({
        adspower_user_id: p.user_id || p.serial_number || "",
        name: p.name || "",
        group: p.group_name || "",
        host: cfg.proxy_host || "",
        port: cfg.proxy_port || "",
      });
    }
    if (list.length < 100) break;
    page++;
    await sleep(AP_RATE);
  }
  console.log(`[sync] collected ${profiles.length} profile(s) to send to cloud`);
  if (profiles[0]) console.log(`[sync] sample profile:`, JSON.stringify(profiles[0]));
  return profiles;
}

async function tick() {
  let job;
  try {
    job = await cloud("GET", "/api/bridge/jobs/next");
  } catch (e) {
    console.error("poll failed:", e.message);
    return;
  }
  if (!job) return;

  console.log(`[job ${job.id}] ${job.type} — running`);
  try {
    const results =
      job.type === "create"
        ? await runCreate(job)
        : job.type === "delete"
        ? await runDelete(job)
        : await runSync(job);
    await cloud("POST", `/api/bridge/jobs/${job.id}/result`, { results });
    if (job.type === "sync") {
      console.log(`[job ${job.id}] sync done — ${results.length} profiles`);
    } else {
      const ok = results.filter((r) => r.ok).length;
      console.log(`[job ${job.id}] done — ${ok}/${results.length} ok`);
    }
  } catch (e) {
    await cloud("POST", `/api/bridge/jobs/${job.id}/result`, {
      results: [],
      error: e.message,
    }).catch(() => {});
    console.error(`[job ${job.id}] error:`, e.message);
  }
}

console.log(`AdsPower bridge → ${CLOUD}\nPolling every ${POLL / 1000}s…`);
async function loop() {
  while (true) {
    await tick();
    await sleep(POLL);
  }
}
loop();