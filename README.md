# AdsPower Console

Cloud brain + local bridge for managing AdsPower profiles and proxies at fleet scale.

- **Cloud** (React + Express + Postgres, deployed on Render): proxy database, AI-assisted
  parsing, used/unused tracking, profile planning UI.
- **Bridge** (small local Node script): runs on the machine with AdsPower, polls the cloud
  for queued jobs, and executes them against the AdsPower Local API.

The cloud never talks to AdsPower directly (it can't reach your localhost). Everything
that touches AdsPower runs through the bridge, which only makes outbound calls.

```
[ React UI ] → [ Express API + Postgres ]  ← polls ←  [ Bridge (your PC) ] → [ AdsPower Local API ]
```

## Deploy the cloud app (Render)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` creates the web
   service **and** a Postgres database, and auto-generates `APP_TOKEN` and `BRIDGE_TOKEN`.
3. (Optional) Set `ANTHROPIC_API_KEY` in the service to enable AI parsing of odd proxy
   formats. Without it, the deterministic parser handles the common shapes.
4. Open the service URL. It asks for the `APP_TOKEN` (find it in the service's Environment
   tab). Enter it once.

## Run the bridge (on your AdsPower machine)

```bash
cd bridge
cp .env.example .env      # fill in CLOUD_URL and BRIDGE_TOKEN (from Render)
npm install
npm start
```

Keep AdsPower open with the Local API enabled. The bridge logs each job it runs.

### Run it hidden + automatic (Windows — easiest)

You don't have to start it by hand or keep a window open. In the `bridge` folder:

1. Copy `.env.example` to `.env` and fill in `CLOUD_URL` and `BRIDGE_TOKEN`.
2. Double-click **`install-bridge-autostart.bat`**.

That installs dependencies, registers a hidden "run at login" task, and starts the bridge
right away with no visible window. From then on it launches itself silently every time the
machine logs in. To undo it, double-click `stop-bridge-autostart.bat`.

Two things it depends on:
- **Node.js 18+** must be installed (https://nodejs.org). The installer checks for it.
- **AdsPower must be running** whenever you want jobs to execute — the bridge talks to
  AdsPower's Local API, which only answers while the app is open. Set AdsPower to launch on
  startup too, so both come up together. Queued jobs simply wait until AdsPower is up.

The web UI header shows **bridge online/offline**, so you can confirm from anywhere that the
machine is up and connected — no need to open the box.

### Alternatives (auto-restart on crash, or run as a true service)

- **pm2 (any OS):** `npm i -g pm2 && pm2 start bridge.js --name adspower-bridge && pm2 save`.
- **NSSM (Windows service):** `nssm install AdsPowerBridge` pointing `node` at `bridge.js`.

These add automatic restart if the process ever crashes. The bridge already retries on
network/AdsPower errors, so the login task above is enough for most setups.

### macOS

Use `pm2` (above) with `pm2 startup`, or a LaunchAgent plist that runs `node bridge.js`.

## Flow

1. **Proxies tab** — paste or upload a proxy list (any common format). It's parsed and
   saved as `unused`.
2. **Create tab** — set a name prefix / group, then select proxies manually, `Random N`,
   or `Smart-suggest N` (subnet-diverse). Hit *Plan & queue*.
3. The bridge picks up the job, creates the profiles in AdsPower, and reports back — those
   proxies flip to `used`, profiles show as `created`.
4. **Jobs tab** — see profiles + job log, export a CSV, or queue deletions (frees proxies
   back to `unused`).

## Local dev

```bash
# terminal 1 — server (needs a Postgres + .env at repo root)
npm install && npm start
# terminal 2 — client with hot reload
npm --prefix client install && npm --prefix client run dev
```

## Security

Proxy credentials live in the cloud DB behind a public URL. Always set `APP_TOKEN` and
`BRIDGE_TOKEN` (Render does this automatically via the blueprint). Don't run tokenless.
