import pkg from "pg";
const { Pool } = pkg;

const url = process.env.DATABASE_URL || "";
// Render Postgres requires SSL; a local dev DB usually does not.
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

export const pool = new Pool({
  connectionString: url,
  ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
create table if not exists proxies (
  id          serial primary key,
  host        text not null,
  port        text not null,
  username    text default '',
  password    text default '',
  proxy_type  text default 'http',
  raw         text default '',
  source      text default '',
  status      text default 'unused',        -- unused | used
  created_at  timestamptz default now()
);
create unique index if not exists proxies_uidx
  on proxies (host, port, username);

create table if not exists profiles (
  id               serial primary key,
  name             text not null,
  group_name       text default '',
  proxy_id         integer references proxies(id) on delete set null,
  adspower_user_id text default '',
  os               text default '',          -- windows | macos (device family) when known
  status           text default 'planned',  -- planned | created | failed | deleted
  created_at       timestamptz default now()
);
-- add os to pre-existing installs that predate the column
alter table profiles add column if not exists os text default '';

create table if not exists jobs (
  id          serial primary key,
  type        text not null,                -- create | delete
  payload     jsonb not null default '{}',
  status      text default 'pending',       -- pending | running | done | error
  result      jsonb default '{}',
  created_at  timestamptz default now(),
  claimed_at  timestamptz,
  finished_at timestamptz
);

create table if not exists meta (
  key   text primary key,
  value text
);
`;

export async function initDb() {
  await pool.query(SCHEMA);
  console.log("[db] schema ready");
}

export const q = (text, params) => pool.query(text, params);
