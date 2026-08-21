# Mobinux

A self-hosted, mobile-first control panel for managing scheduled
scripts and small services on your own EC2 (or any Linux) instance —
from your phone, without SSH.

Built for a specific, common problem: you run a script on a server
(a scheduled job, a small bot, a periodic scraper — anything managed
by systemd) and it occasionally needs a restart, or fails silently
while you're away from your laptop. This project gives you a phone
app with tappable cards instead of a terminal, plus push notifications
when something actually needs your attention.

## Getting the app

**Simplest option — install the APK directly:** go to this repo's
[Releases](../../releases) page, download `mobinux.apk` from the
latest release, and install it on your Android phone (you'll need to
allow "install from unknown sources" for whichever app you download
it with — Android will prompt you for this automatically). No
Node.js, no Expo, nothing else to set up on your phone.

Prefer to run it from source, or build it yourself? See
[`docs/SETUP.md`](docs/SETUP.md) Part 2.

Either way, you still need to deploy the backend on your own server
first — the app is only the remote control; see below.

## What it does

- **Service control** — see whether your scheduled job's last run
  succeeded, trigger it early, restart it, or pause/resume its
  schedule. Add or remove services from the phone; no server-side
  config editing required after initial setup.
- **Push alerts** — a lightweight watchdog checks every service on a
  timer and sends a phone notification (via [ntfy.sh](https://ntfy.sh))
  if a run failed or a schedule got disabled — independent of the app
  being open.
- **Custom command scripts** — save a named, ordered list of shell
  commands (e.g. "activate venv → install deps → run") as a card on
  the home screen; one tap runs the whole sequence, stopping at the
  first failure. Each line can also be run and tested individually.
- **File browser + built-in editor** — browse the server's filesystem,
  open any file in a VS-Code-dark-styled in-app viewer with syntax
  highlighting, edit and save it directly, or hand it off to another
  app on your phone via the native "Open With" sheet.
- **Multi-server support** — save several server profiles (different
  instances, different projects) and switch between them from the app;
  each keeps its own services, connection, and API key.

## Architecture

Two pieces:

- **`backend/`** — a small FastAPI service that runs on the Linux box
  you want to control. It only exposes a fixed set of actions (service
  status/restart/pause/resume, run a command list, browse/read/write
  files) behind a single API key — never raw, unauthenticated shell
  access to the internet.
- **`mobile-app/`** — an Expo (React Native) app. Add it to your phone
  via Expo Go during development, or build a standalone APK later with
  EAS.

See [`docs/SETUP.md`](docs/SETUP.md) for the full deployment walkthrough.

## Security model — read this before exposing anything

- The API is protected by a single bearer key (`CONTROL_API_KEY`).
  Anyone with that key can act as you on the server.
- **Service control** (restart/pause/resume) is restricted to a
  server-defined allow-list — a leaked key can't be used to touch
  unrelated system services.
- **Custom commands** are intentionally unrestricted shell execution —
  this is the trade-off for flexibility. Treat the API key with the
  same care as an SSH private key once you use this feature.
- Always run the backend behind HTTPS (see setup docs) — never expose
  the raw API port to the internet.
- This project was built for solo, personal use on infrastructure you
  fully own and trust. It is not hardened for multi-tenant or
  adversarial environments.

## Requirements

- A Linux server with `systemd` (tested on Ubuntu on EC2; any
  systemd-based distro should work with minor adjustments)
- Python 3.10+
- Node.js + npm, for running/building the mobile app
- A way to reach the server over HTTPS with a real domain name — a
  cloud provider's own auto-generated public DNS hostname will **not**
  work here, since public certificate authorities refuse to issue
  certificates for those domains. A free dynamic-DNS subdomain (e.g.
  DuckDNS) or a domain you own both work fine — see setup docs.

## License / status

Personal project, built iteratively for one person's own
infrastructure. Shared as-is; adapt freely.
