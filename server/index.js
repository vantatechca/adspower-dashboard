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
  const host = req.header("x-bridge-host") || "unknown";
  const version = req.header("x-bridge-version") || "old";
  setMeta("bridge_host", host).catch(() => {});
  setMeta("bridge_version", version).catch(() => {});
  // track each distinct (host,version) so the UI can reveal duplicate bridges
  setMeta(`bridge_seen:${host}|${version}`, Date.now()).catch(() => {});
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
  const now = Date.now();
  // prune bridge_seen rows not heard from in an hour (keeps the table tidy)
  q(`delete from meta where key like 'bridge_seen:%' and value::bigint < $1`, [
    now - 3600000,
  ]).catch(() => {});
  const { rows } = await q(
    `select key, value from meta where key like 'bridge_seen:%'`
  );
  const bridges = [];
  for (const r of rows) {
    const seen = +r.value || 0;
    if (now - seen >= 20000) continue; // active = seen within 20s
    const hv = r.key.slice("bridge_seen:".length);
    const i = hv.lastIndexOf("|");
    bridges.push({
      host: i >= 0 ? hv.slice(0, i) : hv,
      version: i >= 0 ? hv.slice(i + 1) : "old",
      lastSeen: seen,
    });
  }
  bridges.sort((a, b) => b.lastSeen - a.lastSeen);
  const newest = bridges[0] || null;
  res.json({
    online: bridges.length > 0,
    lastSeen: newest ? newest.lastSeen : null,
    host: newest ? newest.host : null,
    version: newest ? newest.version : null,
    bridges,
  });
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
    replaced = 0;
  for (const p of all) {
    // normalize before the uniqueness check: hostnames are case-insensitive,
    // so "ISP.Oxylabs.io" and "isp.oxylabs.io" from two different exports of
    // the same proxy must collide instead of being saved as two rows
    const host = String(p.host || "").trim().toLowerCase();
    const port = String(p.port || "").trim();
    const username = String(p.username || "").trim();
    const password = String(p.password || "").trim();
    if (!host || !port) continue;
    // a re-upload of an already-saved (host, port, username) wins over what
    // was saved before — the freshly uploaded password/type/source replace
    // the old ones on the SAME row, so a profile already pointing at this
    // proxy (status/id untouched) keeps working and AdsPower itself is
    // never contacted here
    const r = await q(
      `insert into proxies (host, port, username, password, proxy_type, raw, source)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (host, port, username) do update set
         password = excluded.password,
         proxy_type = excluded.proxy_type,
         raw = excluded.raw,
         source = excluded.source
       returning (xmax = 0) as inserted`,
      [host, port, username, password, p.proxy_type || "http", p.raw || "", source]
    );
    if (r.rows[0]?.inserted) added++;
    else replaced++;
  }

  const stillFailed = failed.length - recovered.length;
  res.json({
    added,
    replaced,
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
  } else if (status === "failed") {
    sql += ` where p.fail_count > 0`;
  }
  sql += status === "failed"
    ? ` order by p.last_failed_at desc nulls last, p.id desc limit 5000`
    : ` order by p.id desc limit 5000`;
  const { rows } = await q(sql, params);
  res.json(rows);
});

app.get("/api/proxies/stats", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select status, count(*)::int as n from proxies group by status`
  );
  const stats = { unused: 0, used: 0, failed: 0 };
  rows.forEach((r) => (stats[r.status] = r.n));
  const failed = await q(`select count(*)::int as n from proxies where fail_count > 0`);
  stats.failed = failed.rows[0].n;
  res.json(stats);
});

// distinct upload sources among unused proxies, for filtering pickers
app.get("/api/proxies/sources", appAuth, async (_req, res) => {
  const { rows } = await q(
    `select source, count(*)::int as n from proxies
     where status = 'unused' and source <> '' group by source order by n desc`
  );
  res.json(rows);
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

// queue a batch connectivity test — the bridge actually dials each proxy
// from wherever it runs (typically alongside AdsPower), since testing from
// the cloud server would give false negatives for IP-whitelisted proxies
app.post("/api/proxies/test-batch", appAuth, async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: "no proxies" });
  const { rows } = await q(`select * from proxies where id = any($1::int[])`, [ids]);
  if (!rows.length) return res.status(400).json({ error: "no matching proxies" });
  const items = rows.map((p) => ({
    proxy_id: p.id,
    type: p.proxy_type,
    host: p.host,
    port: p.port,
    user: p.username,
    pass: p.password,
  }));
  const job = (
    await q(`insert into jobs (type, payload) values ('test_proxy', $1) returning id`, [
      JSON.stringify({ items }),
    ])
  ).rows[0];
  res.json({ ok: true, job_id: job.id, queued: items.length });
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

app.post("/api/proxies/delete-batch", appAuth, async (req, res) => {
  const ids = (req.body?.ids || []).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "no proxies" });
  const { rowCount } = await q(
    // only 'unused' (which also covers proxies flagged as failed) can be
    // deleted — a proxy currently 'used' by a live profile is left alone
    `delete from proxies where id = any($1::int[]) and status = 'unused'`,
    [ids]
  );
  res.json({ ok: true, deleted: rowCount, skipped: ids.length - rowCount });
});

// safety valve: a proxy can be reserved ('used') while it's queued into a
// create/reassign job, then never get its status flipped back if the job's
// result never lands cleanly (bridge offline, crashed job, stale bridge
// version). This frees any 'used' proxy that:
//   - no live profile ('planned', still awaiting its create job, or
//     'created') actually points at, and
//   - isn't the reserved new-proxy of a still in-flight ('pending' or
//     'running') reassignment job
// so it doesn't stay stranded out of the unused pool while genuinely
// in-flight reservations are left untouched.
app.post("/api/proxies/reconcile", appAuth, async (req, res) => {
  const { rowCount } = await q(
    `update proxies set status = 'unused'
     where status = 'used'
       and not exists (
         select 1 from profiles
         where profiles.proxy_id = proxies.id and profiles.status in ('planned', 'created')
       )
       and not exists (
         select 1 from jobs, jsonb_array_elements(jobs.payload -> 'items') as item
         where jobs.type = 'update_proxy'
           and jobs.status in ('pending', 'running')
           and (item ->> 'new_proxy_id')::int = proxies.id
       )`
  );
  res.json({ ok: true, freed: rowCount });
});

// ══ PROFILES / PLAN ═════════════════════════════════════════════════
app.post("/api/profiles/plan", appAuth, async (req, res) => {
  const { prefix = "Profile", start = 1, group = "", proxy_ids = [], os = "random" } =
    req.body || {};
  if (!proxy_ids.length)
    return res.status(400).json({ error: "no proxies selected" });
  const osChoice = ["windows", "macos", "random"].includes(os) ? os : "random";

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
        [JSON.stringify({ items, os: osChoice })]
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

// reassign a fresh unused proxy to each named profile; the old proxy is
// freed back to the unused pool once the bridge confirms the swap
app.post("/api/profiles/reassign-proxy", appAuth, async (req, res) => {
  const names = [
    ...new Set((req.body?.names || []).map((n) => String(n).trim()).filter(Boolean)),
  ];
  const source = String(req.body?.source || "").trim();
  if (!names.length) return res.status(400).json({ error: "no profile names" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = (
      await client.query(
        `select id, name, proxy_id, adspower_user_id from profiles
         where status = 'created' and adspower_user_id <> '' and name = any($1::text[])
         for update`,
        [names]
      )
    ).rows;
    const foundNames = new Set(found.map((p) => p.name));
    const notFound = names.filter((n) => !foundNames.has(n));

    const items = [];
    const skipped = [];
    for (const prof of found) {
      const px = (
        await client.query(
          source
            ? `select * from proxies where status = 'unused' and source = $1
               order by created_at asc limit 1 for update skip locked`
            : `select * from proxies where status = 'unused'
               order by created_at asc limit 1 for update skip locked`,
          source ? [source] : []
        )
      ).rows[0];
      if (!px) {
        skipped.push(prof.name);
        continue;
      }
      // reserve the new proxy; reverted to 'unused' if the AdsPower update fails
      await client.query(`update proxies set status='used' where id=$1`, [px.id]);
      items.push({
        profile_id: prof.id,
        name: prof.name,
        adspower_user_id: prof.adspower_user_id,
        old_proxy_id: prof.proxy_id,
        new_proxy_id: px.id,
        proxy: {
          type: px.proxy_type,
          host: px.host,
          port: px.port,
          user: px.username,
          pass: px.password,
        },
      });
    }
    if (!items.length) {
      await client.query("rollback");
      return res.status(400).json({
        error: source
          ? `no matching profiles with an unused proxy available from source "${source}"`
          : "no matching profiles with an unused proxy available",
        notFound,
        skipped,
      });
    }
    const job = (
      await client.query(
        `insert into jobs (type, payload) values ('update_proxy', $1) returning id`,
        [JSON.stringify({ items })]
      )
    ).rows[0];
    await client.query("commit");
    res.json({ ok: true, job_id: job.id, queued: items.length, notFound, skipped });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
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
            `update profiles set status='created', adspower_user_id=$1, os=coalesce($2, os) where id=$3`,
            [r.adspower_user_id || "", r.os || null, r.profile_id]
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
          // create failed — release the reserved proxy back to the pool and
          // record the failure so it shows up in the Proxies "failed" tab
          await client.query(
            `update proxies set status='unused', fail_count = fail_count + 1,
             last_error = $1, last_failed_at = now()
             where id = (select proxy_id from profiles where id=$2)`,
            [(r.msg || "unknown error").slice(0, 500), r.profile_id]
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
    } else if (job.type === "update_proxy") {
      // each result runs inside its own savepoint: one malformed/unexpected
      // result (e.g. a stale bridge posting a different shape) must not
      // abort the whole batch and strand every other reserved proxy as
      // 'used' with no code path left to free it back to the pool
      for (const r of results) {
        await client.query("savepoint sp");
        try {
          if (r.ok && r.new_proxy_id && r.profile_id) {
            await client.query(`update profiles set proxy_id=$1 where id=$2`, [
              r.new_proxy_id,
              r.profile_id,
            ]);
            if (r.old_proxy_id) {
              await client.query(`update proxies set status='unused' where id=$1`, [
                r.old_proxy_id,
              ]);
            }
          } else if (r.new_proxy_id) {
            // update failed — release the reserved new proxy back to the
            // pool and record the failure; the old proxy keeps serving
            await client.query(
              `update proxies set status='unused', fail_count = fail_count + 1,
               last_error = $1, last_failed_at = now()
               where id = $2`,
              [(r.msg || "unknown error").slice(0, 500), r.new_proxy_id]
            );
          }
          await client.query("release savepoint sp");
        } catch (e) {
          await client.query("rollback to savepoint sp");
        }
      }
    } else if (job.type === "test_proxy") {
      for (const r of results) {
        if (!r.proxy_id) continue;
        await client.query("savepoint sp");
        try {
          await client.query(
            `update proxies set
               last_checked_at = now(),
               last_check_ok = $1,
               last_check_ms = $2,
               last_check_error = $3
             where id = $4`,
            [Boolean(r.ok), r.ms ?? null, (r.msg || "").slice(0, 500), r.proxy_id]
          );
          await client.query("release savepoint sp");
        } catch (e) {
          await client.query("rollback to savepoint sp");
        }
      }
    } else if (job.type === "sync") {
      // results = live AdsPower profiles [{adspower_user_id, name, group, host, port}]
      const live = results || [];
      const liveIds = new Set(live.map((p) => p.adspower_user_id).filter(Boolean));
      let matchedProxy = 0, addedProxy = 0, newProfile = 0, updatedProfile = 0, noProxyInfo = 0, failed = 0;
      const errors = [];

      // 1) import EVERY live profile. Link it to a matching proxy in our
      //    inventory when we have one; otherwise add the proxy so the profile
      //    is still recorded (host/port may be blank if AdsPower omits it).
      //    Each profile runs inside its own savepoint, so one bad row can't
      //    abort the whole import — it's counted as failed and reported.
      for (const p of live) {
        await client.query("savepoint sp");
        try {
          let proxyId = null;
          let dAdded = 0, dMatched = 0, dNoInfo = 0;
          if (p.host && p.port) {
            let px = (
              await client.query(
                `select id from proxies where host=$1 and port=$2
                 order by (status='unused') desc limit 1`,
                [p.host, p.port]
              )
            ).rows[0];
            if (!px) {
              // not in inventory — add it. Plain insert is safe: we only get
              // here when no row for this host:port exists yet.
              dAdded = 1;
              px = (
                await client.query(
                  `insert into proxies (host, port, proxy_type, source, status)
                   values ($1,$2,'http','adspower-sync','used') returning id`,
                  [p.host, p.port]
                )
              ).rows[0];
            } else {
              dMatched = 1;
              await client.query(`update proxies set status='used' where id=$1`, [px.id]);
            }
            proxyId = px.id;
          } else {
            dNoInfo = 1;
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
            await client.query(
              `update profiles
               set name=$1, group_name=$2, proxy_id=coalesce($3, proxy_id), status='created'
               where id=$4`,
              [p.name || "", p.group || "", proxyId, existing.id]
            );
          } else {
            await client.query(
              `insert into profiles (name, group_name, proxy_id, adspower_user_id, status)
               values ($1,$2,$3,$4,'created')`,
              [p.name || "", p.group || "", proxyId, p.adspower_user_id || ""]
            );
          }
          await client.query("release savepoint sp");
          addedProxy += dAdded;
          matchedProxy += dMatched;
          noProxyInfo += dNoInfo;
          existing ? updatedProfile++ : newProfile++;
        } catch (e) {
          await client.query("rollback to savepoint sp");
          failed++;
          if (errors.length < 5)
            errors.push(`${p.name || p.adspower_user_id || "?"}: ${e.message}`);
        }
      }
      syncSummary = {
        returned: live.length,
        newProfile,
        updatedProfile,
        matchedProxy,
        addedProxy,
        noProxyInfo,
        failed,
        errors,
      };

      // 2) reconcile deletions: profiles we recorded as created whose AdsPower
      //    id is no longer live were removed in AdsPower. Mark deleted and free
      //    the proxy if nothing else is using it. Wrapped in a savepoint so a
      //    failure here can't roll back the imports above.
      await client.query("savepoint recon");
      try {
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
        await client.query("release savepoint recon");
      } catch (e) {
        await client.query("rollback to savepoint recon");
      }

      // 3) reconcile stray 'used' proxies against AdsPower ground truth. A
      //    proxy can end up marked 'used' without actually being configured
      //    on any live AdsPower profile — a reservation that got stranded,
      //    or a profile whose proxy was changed directly in AdsPower (step 1
      //    above repoints profiles.proxy_id to the newly-matched proxy but
      //    never frees whatever it used to point at). Free any 'used' proxy
      //    whose host:port isn't configured on ANY live profile, unless it's
      //    genuinely still reserved for a profile mid-create or mid-reassign.
      //    Skipped entirely when AdsPower reported zero profiles with proxy
      //    info — far more likely a fetch/API hiccup than a truly empty
      //    account, and wiping every 'used' proxy on a hiccup would be worse
      //    than leaving this pass for the next successful sync.
      const liveHosts = [];
      const livePorts = [];
      for (const p of live) {
        if (!p.host || !p.port) continue;
        liveHosts.push(String(p.host).trim().toLowerCase());
        livePorts.push(String(p.port).trim());
      }
      if (liveHosts.length) {
        await client.query("savepoint proxrecon");
        try {
          const freedProxy = await client.query(
            `update proxies set status = 'unused'
             where status = 'used'
               and not exists (
                 select 1 from unnest($1::text[], $2::text[]) as t(h, p)
                 where t.h = lower(proxies.host) and t.p = proxies.port
               )
               and not exists (
                 select 1 from profiles
                 where profiles.proxy_id = proxies.id and profiles.status = 'planned'
               )
               and not exists (
                 select 1 from jobs, jsonb_array_elements(jobs.payload -> 'items') as item
                 where jobs.type = 'update_proxy'
                   and jobs.status in ('pending', 'running')
                   and (item ->> 'new_proxy_id')::int = proxies.id
               )`,
            [liveHosts, livePorts]
          );
          syncSummary.freedProxy = freedProxy.rowCount;
          await client.query("release savepoint proxrecon");
        } catch (e) {
          await client.query("rollback to savepoint proxrecon");
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
    `select pr.name, pr.group_name, pr.os, p.host, p.port
     from profiles pr join proxies p on p.id = pr.proxy_id
     where pr.status = 'created' order by pr.name`
  );
  const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const osLabel = { windows: "Windows", macos: "macOS" };
  const lines = ["Name,Group,Device,Proxy host:port"];
  for (const r of rows)
    lines.push(
      [csv(r.name), csv(r.group_name || ""), csv(osLabel[r.os] || ""), csv(`${r.host}:${r.port}`)].join(",")
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