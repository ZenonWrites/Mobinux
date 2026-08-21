# Setup Guide

This walks through deploying the backend on your server and running
the mobile app. Written for Ubuntu on EC2, but applies to any
systemd-based Linux box with minor path/package-manager adjustments.

---

## Before you start

**Is your script already running as a systemd service?** This project
assumes it is. Two common shapes it supports:

- **A long-running daemon** (`Type=simple`, `Restart=on-failure`) —
  stays alive continuously.
- **A scheduled one-shot job** (`Type=oneshot` service triggered by a
  matching `.timer` unit) — runs at set times, exits, and "inactive"
  between runs is normal, not a failure. The backend's status logic is
  written for this pattern specifically: it reports whether the *last
  run* succeeded and whether the *timer* is still armed, rather than
  whether a process is currently alive.

If your script isn't under systemd yet, wrap it in a unit file first —
plenty of tutorials cover this, and it's worth doing independently of
this project (auto-restart, boot persistence, real logs via
`journalctl`).

---

## Part 1 — Backend

### 1.1 Install

```bash
sudo mkdir -p /opt/ec2-control/backend /var/lib/ec2-control
sudo cp backend/*.py backend/requirements.txt /opt/ec2-control/backend/
cd /opt/ec2-control/backend
sudo python3 -m venv venv
sudo ./venv/bin/pip install -r requirements.txt
```

### 1.2 Configure secrets via `.env`

```bash
sudo cp .env.example /opt/ec2-control/backend/.env
sudo nano /opt/ec2-control/backend/.env
```

Fill in at minimum:
- `CONTROL_API_KEY` — generate with `openssl rand -hex 32`. This is
  effectively as sensitive as an SSH key — anyone with it can act as
  you on this server.
- `SERVICES` — `Display Name:unit-name` pairs, comma-separated. This
  only *seeds* the list on first run; after that, services are managed
  from the app itself.

`.env` is never committed to version control — keep it out of git.

### 1.3 Fix the user account in the unit files

The provided `.service` files default to `User=ubuntu`. If your
server's default account has a different name (varies by AMI/distro —
Amazon Linux typically uses `ec2-user`), edit both `.service` files to
match before installing them, or every action will fail with a
"Result: exit-code" / user-not-found error.

### 1.4 Allow systemd actions without an interactive password prompt

Because the API runs as a background service (not a logged-in desktop
session), Linux's `polkit` will otherwise block every restart/start/
stop with "interactive authentication required." Fix once:

```bash
sudo cp backend/49-ec2-control-nopasswd.rules /etc/polkit-1/rules.d/
sudo systemctl restart polkit
```

This rule scopes the exception to the specific user running the
backend — check the file and adjust the username if you changed it in
step 1.3.

### 1.5 Install the systemd units

```bash
sudo cp backend/*.service backend/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ec2-control-api
```

Verify: `sudo systemctl status ec2-control-api` should show
`active (running)`. If not, `sudo journalctl -u ec2-control-api -n 50`
shows the real error.

Don't enable the watchdog timer yet — that's step 1.7, after HTTPS is
confirmed working.

### 1.6 Put HTTPS in front of it

The backend only listens on `127.0.0.1:8000` — never expose that port
directly. Put a reverse proxy in front with a real certificate.

**Important:** your cloud provider's auto-generated public DNS name
(e.g. anything ending in `.amazonaws.com`) **cannot** get a Let's
Encrypt certificate — public CAs refuse to issue for that domain
space, full stop, regardless of Caddyfile configuration. You need
either a domain you own, or a free dynamic-DNS subdomain (e.g.
[DuckDNS](https://www.duckdns.org)) pointed at your server's public
IP.

Using [Caddy](https://caddyserver.com) (simplest automatic-HTTPS
option):

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:
```
your-domain-or-duckdns-subdomain.example {
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo systemctl restart caddy
```

Open inbound ports **80 and 443** in your security group (80 is
needed briefly for certificate issuance even though normal traffic
uses 443).

If you're on a dynamic IP (no Elastic IP / static address), your
DuckDNS record needs updating whenever the server's public IP changes
— their site provides a small update script for this.

### 1.7 Verify, then enable the watchdog

```bash
curl https://your-domain/health
# {"ok":true}

curl -H "x-api-key: YOUR_KEY" https://your-domain/status?service=your-unit-name
```

If the status response matches reality, enable alerting:

1. Create a random, unguessable topic at [ntfy.sh](https://ntfy.sh)
   and put it in `.env` as `NTFY_TOPIC`.
2. Install the ntfy app on your phone, subscribe to that same topic.
3. `sudo systemctl enable --now ec2-control-watchdog.timer`

---

## Part 2 — Mobile app

### Option A — Install the pre-built APK (simplest)

Go to this repo's **Releases** page, download `mobinux.apk` from the
latest release, and install it directly on an Android phone. Android
will prompt you to allow "install from unknown sources" the first
time — that's expected for any APK installed outside the Play Store.

First launch prompts for:
- **Server URL** — your HTTPS domain from step 1.6, no trailing slash
- **API Key** — from `.env`

Add more servers later from the app's Servers screen — no reinstall
needed. Skip straight to Troubleshooting below.

### Option B — Run it from source with Expo Go (for development)

```bash
cd mobile-app
npm install
npx expo install --fix   # aligns dependency versions with your Expo Go version
npx expo start
```

Scan the QR code with **Expo Go** on your phone.

### Option C — Build your own APK

Requires a free [expo.dev](https://expo.dev) account.

```bash
cd mobile-app
npm install -g eas-cli
eas login
eas build --platform android --profile preview
```

This builds in Expo's cloud and gives you a download link when it
finishes — no local Android SDK required. The `preview` profile in
`eas.json` is specifically configured to output a directly-installable
`.apk` rather than the Play-Store-only `.aab` format Expo defaults to.

**Automating this into a GitHub Release:** `.github/workflows/release-apk.yml`
runs this exact build automatically and attaches the resulting APK to
a new GitHub Release whenever you push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This needs one one-time setup step: generate an access token at
`https://expo.dev/accounts/[your-account]/settings/access-tokens`,
then add it to this repo under **Settings → Secrets and variables →
Actions** as a secret named `EXPO_TOKEN`.

---

## Troubleshooting

- **"Interactive authentication required" on any service action** →
  step 1.4 wasn't applied, or the username in the rule doesn't match
  the user actually running the API.
- **TLS/certificate errors** → almost always the "can't get a cert for
  a cloud-provider domain" issue from step 1.6 — switch to a real
  domain or DuckDNS.
- **404 on every request from the app, but `curl` works** → check the
  Server URL field in the app for a trailing slash.
- **A service always shows "inactive" even though it's running fine**
  → its unit name in the app doesn't match the real systemd unit —
  double check with `systemctl status <name>` on the server.
