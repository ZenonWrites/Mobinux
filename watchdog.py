"""
Watchdog
--------
Runs every few minutes (via systemd timer). For a SCHEDULED, ONE-SHOT
bot (Type=oneshot service + .timer), the meaningful failure signals are:

1. The last run ended in error (systemctl is-failed == "failed")
2. The timer itself got disabled/stopped somehow, so future runs won't
   fire at all

Sends a push notification via ntfy.sh for either case — no Firebase,
no app backend needed for this part.

Install the ntfy Android app and subscribe to your NTFY_TOPIC to get
these instantly, anywhere.
"""

import os
import subprocess
import time
import urllib.request

SERVICE_NAME = os.environ.get("SERVICE_NAME", "python-bot")
TIMER_NAME = os.environ.get("TIMER_NAME", SERVICE_NAME)
NTFY_TOPIC = os.environ.get("NTFY_TOPIC")  # e.g. "zenon-ec2-alerts-8f2k1"
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}" if NTFY_TOPIC else None

# Avoid re-alerting every few minutes while the same failure persists.
COOLDOWN_FILE = "/var/lib/ec2-control/last_alert"
COOLDOWN_SECONDS = 15 * 60


def systemctl(*args) -> str:
    result = subprocess.run(["systemctl", *args], capture_output=True, text=True)
    return result.stdout.strip()


def send_alert(message: str, title: str = "EC2 bot alert"):
    if not NTFY_URL:
        print("NTFY_TOPIC not set, skipping push notification:", message)
        return
    if os.path.exists(COOLDOWN_FILE):
        age = time.time() - os.path.getmtime(COOLDOWN_FILE)
        if age < COOLDOWN_SECONDS:
            return  # already alerted recently
    req = urllib.request.Request(
        NTFY_URL,
        data=message.encode("utf-8"),
        headers={"Title": title, "Priority": "urgent", "Tags": "warning"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print("Failed to send ntfy alert:", e)
    os.makedirs(os.path.dirname(COOLDOWN_FILE), exist_ok=True)
    with open(COOLDOWN_FILE, "w") as f:
        f.write(str(time.time()))


def main():
    os.makedirs(os.path.dirname(COOLDOWN_FILE), exist_ok=True)

    if systemctl("is-failed", SERVICE_NAME) == "failed":
        send_alert(
            f"{SERVICE_NAME}'s last scheduled run failed. Check logs in the app.",
            title="Bot run failed",
        )
        return

    if systemctl("is-active", f"{TIMER_NAME}.timer") != "active":
        send_alert(
            f"{TIMER_NAME}.timer is not active — scheduled runs will NOT fire "
            "until it's resumed.",
            title="Bot schedule disabled",
        )


if __name__ == "__main__":
    main()