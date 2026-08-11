import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { pool, q, initDb } from "./db.js";
import { parseText } from "./parse.js";
import { aiParse, aiEnabled } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── meta helpers ────────────────────────────────────────────────────
async function setMeta(key, value) {
  await q(
    `insert into meta (key, value) values ($1,$2)
     on conflict (key) do update set value = excluded.value`,
    [key, String(value)]
  );
}

// ── auth ────────────────────────────────────────────────────────────
function appAuth(req, res, next) {
  const t = process.env.APP_TOKEN;
  if (!t) return next(); // dev mode: no token set
  if (req.header("x-app-token") === t) return next();
  return res.status(401).json({ error: "unauthorized" });
}
function bridgeAuth(req, res, next) {
  const t = process.env.BRIDGE_TOKEN;
  if (t && req.header("x-bridge-token") !== t)
    return res.status(401).json({ error: "unauthorized bridge" });
  // heartbeat (fire and forget)
  setMeta("bridge_last_seen", Date.now()).catch(() => {});
  const host = req.header("x-bridge-host");
  if (host) setMeta("bridge_host", host).catch(() => {});
  next();
}

// tiny helper for /24 grouping
const subnet = (host) => {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : host;
};

// ── health / config (public) ────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, tokenRequired: Boolean(process.env.APP_TOKEN), ai: aiEnabled() })
);

app.get("/api/bridge/status", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select key, value from meta where key in ('bridge_last_seen','bridge_host')`
  );
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const last = m.bridge_last_seen ? +m.bridge_last_seen : 0;
  const online = last && Date.now() - last < 20000; // seen within 20s
  res.json({ online: Boolean(online), lastSeen: last || null, host: m.bridge_host || null });
});

// ══ PROXIES ═════════════════════════════════════════════════════════
app.post("/api/proxies/upload", appAuth, async (req, res) => {
  const { text = "", source = "", useAi = true } = req.body || {};
  const { parsed, failed } = parseText(text);

  let recovered = [];
  if (useAi && failed.length && aiEnabled()) {
    recovered = await aiParse(failed);
  }
  const all = [...parsed, ...recovered];

  let added = 0,
    dupe = 0;
  for (const p of all) {
    if (!p.host || !p.port) continue;
    const r = await q(
      `insert into proxies (host, port, username, password, proxy_type, raw, source)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (host, port, username) do nothing
       returning id`,
      [p.host, p.port, p.username || "", p.password || "", p.proxy_type || "http", p.raw || "", source]
    );
    if (r.rowCount) added++;
    else dupe++;
  }

  const stillFailed = failed.length - recovered.length;
  res.json({
    added,
    duplicates: dupe,
    aiRecovered: recovered.length,
    unparsed: stillFailed < 0 ? 0 : stillFailed,
    failedSample: failed.slice(0, 8),
  });
});

app.get("/api/proxies", appAuth, async (req, res) => {
  const status = req.query.status || "all";
  let sql = `select p.*, pr.name as profile_name
             from proxies p
             left join profiles pr on pr.proxy_id = p.id and pr.status = 'created'`;
  const params = [];
  if (status === "unused" || status === "used") {
    params.push(status);
    sql += ` where p.status = $1`;
  }
  sql += ` order by p.id desc limit 5000`;
  const { rows } = await q(sql, params);
  res.json(rows);
});

app.get("/api/proxies/stats", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select status, count(*)::int as n from proxies group by status`
  );
  const stats = { unused: 0, used: 0 };
  rows.forEach((r) => (stats[r.status] = r.n));
  res.json(stats);
});

// smart suggestion: subnet-diverse unused proxies
app.post("/api/proxies/suggest", appAuth, async (req, res) => {
  const count = Math.max(1, Math.min(500, +(req.body?.count || 10)));
  const { rows } = await q(
    `select * from proxies where status = 'unused' order by created_at asc`
  );
  const buckets = new Map();
  for (const p of rows) {
    const s = subnet(p.host);
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(p);
  }
  const order = [...buckets.values()];
  const picked = [];
  let i = 0;
  while (picked.length < count && order.some((b) => b.length)) {
    const b = order[i % order.length];
    if (b.length) picked.push(b.shift());
    i++;
  }
  res.json(picked);
});

app.delete("/api/proxies/:id", appAuth, async (req, res) => {
  const { rowCount } = await q(
    `delete from proxies where id = $1 and status = 'unused'`,
    [req.params.id]
  );
  if (!rowCount)
    return res.status(400).json({ error: "not found or in use" });
  res.json({ ok: true });
});

// ══ PROFILES / PLAN ═════════════════════════════════════════════════
app.post("/api/profiles/plan", appAuth, async (req, res) => {
  const { prefix = "Profile", start = 1, group = "", proxy_ids = [] } =
    req.body || {};
  if (!proxy_ids.length)
    return res.status(400).json({ error: "no proxies selected" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const items = [];
    let n = +start;
    for (const pid of proxy_ids) {
      const px = (
        await client.query(
          `select * from proxies where id = $1 and status = 'unused' for update`,
          [pid]
        )
      ).rows[0];
      if (!px) continue; // already used / gone
      const name = `${prefix} ${n}`.trim();
      const prof = (
        await client.query(
          `insert into profiles (name, group_name, proxy_id, status)
           values ($1,$2,$3,'planned') returning id`,
          [name, group, pid]
        )
      ).rows[0];
      // reserve the proxy so it can't be queued into a second job before the
      // bridge runs; reverted to 'unused' if the AdsPower create later fails.
      await client.query(`update proxies set status='used' where id=$1`, [pid]);
      items.push({
        profile_id: prof.id,
        name,
        group,
        proxy: {
          type: px.proxy_type,
          host: px.host,
          port: px.port,
          user: px.username,
          pass: px.password,
        },
      });
      n++;
    }
    if (!items.length) {
      await client.query("rollback");
      return res.status(400).json({ error: "selected proxies already in use" });
    }
    const job = (
      await client.query(
        `insert into jobs (type, payload) values ('create', $1) returning id`,
        [JSON.stringify({ items })]
      )
    ).rows[0];
    await client.query("commit");
    res.json({ ok: true, job_id: job.id, planned: items.length });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get("/api/profiles", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select pr.*, p.host, p.port
     from profiles pr left join proxies p on p.id = pr.proxy_id
     order by pr.id desc limit 5000`
  );
  res.json(rows);
});

app.post("/api/profiles/delete", appAuth, async (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "no profiles" });
  const { rows } = await q(
    `select id, adspower_user_id from profiles
     where id = any($1::int[]) and status = 'created' and adspower_user_id <> ''`,
    [ids]
  );
  if (!rows.length)
    return res.status(400).json({ error: "no created profiles to delete" });
  const job = (
    await q(`insert into jobs (type, payload) values ('delete', $1) returning id`, [
      JSON.stringify({ items: rows.map((r) => ({ profile_id: r.id, adspower_user_id: r.adspower_user_id })) }),
    ])
  ).rows[0];
  res.json({ ok: true, job_id: job.id, queued: rows.length });
});

// enqueue a sync job (bridge pulls AdsPower's real profile list to reconcile)
app.post("/api/profiles/sync", appAuth, async (_req, res) => {
  const job = (
    await q(`insert into jobs (type, payload) values ('sync', '{}') returning id`)
  ).rows[0];
  res.json({ ok: true, job_id: job.id });
});

// ══ JOBS (UI view) ══════════════════════════════════════════════════
app.get("/api/jobs", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select id, type, status, result, created_at, finished_at
     from jobs order by id desc limit 50`
  );
  res.json(rows);
});

// ══ BRIDGE (local agent polls these) ════════════════════════════════
// claim next pending job atomically
app.get("/api/bridge/jobs/next", bridgeAuth, async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const job = (
      await client.query(
        `select * from jobs where status = 'pending'
         order by id asc for update skip locked limit 1`
      )
    ).rows[0];
    if (!job) {
      await client.query("commit");
      return res.json(null);
    }
    await client.query(
      `update jobs set status = 'running', claimed_at = now() where id = $1`,
      [job.id]
    );
    await client.query("commit");
    res.json(job);
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// bridge reports results
app.post("/api/bridge/jobs/:id/result", bridgeAuth, async (req, res) => {
  const jobId = req.params.id;
  const { results = [], error } = req.body || {};
  const job = (await q(`select * from jobs where id = $1`, [jobId])).rows[0];
  if (!job) return res.status(404).json({ error: "no such job" });

  const client = await pool.connect();
  let syncSummary = null;
  try {
    await client.query("begin");
    if (job.type === "create") {
      for (const r of results) {
        if (r.ok) {
          await client.query(
            `update profiles set status='created', adspower_user_id=$1 where id=$2`,
            [r.adspower_user_id || "", r.profile_id]
          );
          await client.query(
            `update proxies set status='used'
             where id = (select proxy_id from profiles where id=$1)`,
            [r.profile_id]
          );
        } else {
          await client.query(
            `update profiles set status='failed' where id=$1`,
            [r.profile_id]
          );
          // create failed — release the reserved proxy back to the pool
          await client.query(
            `update proxies set status='unused'
             where id = (select proxy_id from profiles where id=$1)`,
            [r.profile_id]
          );
        }
      }
    } else if (job.type === "delete") {
      for (const r of results) {
        if (r.ok) {
          await client.query(
            `update proxies set status='unused'
             where id = (select proxy_id from profiles where id=$1)`,
            [r.profile_id]
          );
          await client.query(
            `update profiles set status='deleted' where id=$1`,
            [r.profile_id]
          );
        }
      }
    } else if (job.type === "sync") {
      // results = live AdsPower profiles [{adspower_user_id, name, group, host, port}]
      const live = results || [];
      const liveIds = new Set(live.map((p) => p.adspower_user_id).filter(Boolean));
      let matchedProxy = 0, addedProxy = 0, newProfile = 0, updatedProfile = 0, noProxyInfo = 0;

      // 1) import EVERY live profile. Link it to a matching proxy in our
      //    inventory when we have one; otherwise add the proxy so the profile
      //    is still recorded (host/port may be blank if AdsPower omits it).
      for (const p of live) {
        let proxyId = null;
        if (p.host && p.port) {
          let px = (
            await client.query(
              `select id from proxies where host=$1 and port=$2
               order by (status='unused') desc limit 1`,
              [p.host, p.port]
            )
          ).rows[0];
          if (!px) {
            addedProxy++;
            px = (
              await client.query(
                `insert into proxies (host, port, proxy_type, source, status)
                 values ($1,$2,'http','adspower-sync','used')
                 on conflict (host, port, username)
                 do update set status='used' returning id`,
                [p.host, p.port]
              )
            ).rows[0];
          } else {
            matchedProxy++;
            await client.query(`update proxies set status='used' where id=$1`, [px.id]);
          }
          proxyId = px.id;
        } else {
          noProxyInfo++;
        }

        // upsert the profile keyed on AdsPower's own id (stable across syncs)
        const existing = p.adspower_user_id
          ? (
              await client.query(
                `select id from profiles where adspower_user_id=$1 limit 1`,
                [p.adspower_user_id]
              )
            ).rows[0]
          : null;
        if (existing) {
          updatedProfile++;
          await client.query(
            `update profiles
             set name=$1, group_name=$2, proxy_id=coalesce($3, proxy_id), status='created'
             where id=$4`,
            [p.name || "", p.group || "", proxyId, existing.id]
          );
        } else {
          newProfile++;
          await client.query(
            `insert into profiles (name, group_name, proxy_id, adspower_user_id, status)
             values ($1,$2,$3,$4,'created')`,
            [p.name || "", p.group || "", proxyId, p.adspower_user_id || ""]
          );
        }
      }
      syncSummary = {
        returned: live.length,
        newProfile,
        updatedProfile,
        matchedProxy,
        addedProxy,
        noProxyInfo,
      };

      // 2) reconcile deletions: profiles we recorded as created whose AdsPower
      //    id is no longer live were removed in AdsPower. Mark deleted and free
      //    the proxy if nothing else is using it.
      const known = (
        await client.query(
          `select id, proxy_id, adspower_user_id from profiles
           where status='created' and adspower_user_id <> ''`
        )
      ).rows;
      for (const k of known) {
        if (liveIds.has(k.adspower_user_id)) continue;
        await client.query(`update profiles set status='deleted' where id=$1`, [k.id]);
        if (k.proxy_id) {
          const other = (
            await client.query(
              `select 1 from profiles where proxy_id=$1 and status='created' limit 1`,
              [k.proxy_id]
            )
          ).rows[0];
          if (!other)
            await client.query(`update proxies set status='unused' where id=$1`, [k.proxy_id]);
        }
      }
    }
    await client.query(
      `update jobs set status=$1, result=$2, finished_at=now() where id=$3`,
      [error ? "error" : "done", JSON.stringify({ results, error, summary: syncSummary }), jobId]
    );
    await client.query("commit");
    res.json({ ok: true });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ══ EXPORT ══════════════════════════════════════════════════════════
app.get("/api/export.csv", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select pr.name, pr.group_name, p.host, p.port
     from profiles pr join proxies p on p.id = pr.proxy_id
     where pr.status = 'created' order by pr.name`
  );
  const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["Name,Group,Proxy host:port"];
  for (const r of rows)
    lines.push(
      [csv(r.name), csv(r.group_name || ""), csv(`${r.host}:${r.port}`)].join(",")
    );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=adspower_profiles.csv");
  res.send(lines.join("\n"));
});

// ── static React ────────────────────────────────────────────────────
const dist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const PORT = process.env.PORT || 5000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`[server] on :${PORT}`)))
  .catch((e) => {
    console.error("[server] db init failed:", e.message);
    process.exit(1);
  });