import "dotenv/config";
import os from "os";

const CLOUD = (process.env.CLOUD_URL || "").replace(/\/$/, "");
const TOKEN = process.env.BRIDGE_TOKEN || "";
const AP = process.env.ADSPOWER_API || "http://local.adspower.net:50325";
const POLL = (+process.env.POLL_SECONDS || 5) * 1000;
const AP_RATE = 1100; // AdsPower: 1 req/sec
const HOST = os.hostname();
// Bump when bridge behaviour changes; surfaced in the web UI so you can tell
// at a glance whether the running bridge has the latest code.
const BRIDGE_VERSION = "update-proxy";

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
      "x-bridge-version": BRIDGE_VERSION,
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

// ── fingerprint randomisation ───────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// AdsPower ua_system_version values that pin a profile to an OS family.
const OS_SYSTEM = { windows: "Windows", macos: "Mac OS X" };

// OS-appropriate WebGL vendor/renderer pools (kept consistent with the OS)
const WEBGL = {
  windows: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon(TM) RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  ],
  macos: [
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M1, OpenGL 4.1 Metal - 76.3)" },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2, OpenGL 4.1 Metal - 83)" },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1 Metal - 76.3)" },
    { vendor: "Apple Inc.", renderer: "Apple GPU" },
  ],
};

// Resolve the batch OS setting to one concrete OS for a single profile.
function resolveOs(os) {
  if (os === "windows" || os === "macos") return os;
  return pick(["windows", "macos"]); // "random" → mix Windows + Mac per profile
}

// Build a fingerprint pinned to `resolvedOs` (windows|macos). Mirrors the
// AdsPower UI "OS: All <family>" + "User Agent: All":
//   random_ua.ua_system_version = the OS family (Windows / Mac OS X); ua_version
//   omitted so AdsPower randomises the browser version within that OS.
// IMPORTANT: do NOT also send an explicit `ua` — providing both makes AdsPower
// ignore the constraint and fall back to a random OS. No browser_kernel_config
// "ua_auto" either (that was the original random-OS override).
function buildFingerprint(resolvedOs) {
  const gl = pick(WEBGL[resolvedOs]);
  return {
    automatic_timezone: "1",
    language: ["en-US"],
    webrtc: "proxy",
    random_ua: { ua_system_version: [OS_SYSTEM[resolvedOs]] },
    // WebGL metadata: Custom (OS-appropriate vendor/renderer) + image noise
    webgl_image: "1",
    webgl_config: { webgl_vendor: gl.vendor, webgl_renderer: gl.renderer },
  };
}

async function runCreate(job) {
  const items = job.payload.items || [];
  const os = job.payload.os || "random"; // windows | macos | random
  console.log(`[create] job ${job.id}: ${items.length} profile(s), OS setting = ${os} (OS-pinned fingerprint)`);
  const results = [];
  const groupCache = {};
  for (const it of items) {
    const g = it.group || "";
    if (!(g in groupCache)) groupCache[g] = await resolveGroupId(g);
    const px = it.proxy || {};
    const resolvedOs = resolveOs(os);
    console.log(`[create]  → ${it.name}: os=${resolvedOs}`);
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
      fingerprint_config: buildFingerprint(resolvedOs),
    };
    try {
      const r = await apPost("/api/v1/user/create", payload);
      if (r.code === 0)
        results.push({ profile_id: it.profile_id, ok: true, adspower_user_id: r.data.id, os: resolvedOs });
      else results.push({ profile_id: it.profile_id, ok: false, msg: r.msg });
    } catch (e) {
      results.push({ profile_id: it.profile_id, ok: false, msg: e.message });
    }
    await sleep(AP_RATE);
  }
  return results;
}

async function runUpdateProxy(job) {
  const items = job.payload.items || [];
  console.log(`[update_proxy] job ${job.id}: ${items.length} profile(s)`);
  const results = [];
  for (const it of items) {
    const px = it.proxy || {};
    const payload = {
      user_id: it.adspower_user_id,
      user_proxy_config: {
        proxy_soft: "other",
        proxy_type: px.type || "http",
        proxy_host: px.host,
        proxy_port: px.port,
        proxy_user: px.user || "",
        proxy_password: px.pass || "",
      },
    };
    try {
      const r = await apPost("/api/v1/user/update", payload);
      results.push({
        profile_id: it.profile_id,
        ok: r.code === 0,
        msg: r.code === 0 ? "" : r.msg,
        new_proxy_id: it.new_proxy_id,
        old_proxy_id: it.old_proxy_id,
      });
    } catch (e) {
      results.push({
        profile_id: it.profile_id,
        ok: false,
        msg: e.message,
        new_proxy_id: it.new_proxy_id,
        old_proxy_id: it.old_proxy_id,
      });
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
        : job.type === "update_proxy"
        ? await runUpdateProxy(job)
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

console.log(`AdsPower bridge [os-pin build] → ${CLOUD}\nPolling every ${POLL / 1000}s…`);
async function loop() {
  while (true) {
    await tick();
    await sleep(POLL);
  }
}
loop();