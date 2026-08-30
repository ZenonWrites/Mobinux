"""
EC2 Bot Control API
--------------------
Service control (status/logs/run-now/restart/pause/resume) against a
phone-editable allow-list, plus custom shell commands, plus a small
file browser. All three share ONE persisted "current directory"
(CWD_FILE) so a `cd` typed as a custom command is reflected in the file
browser, and vice versa.

Run this behind HTTPS and never expose port 8000 directly.
"""

import asyncio
import json
import mimetypes
import os
import pty
import re
import select
import signal
import subprocess
import threading
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

API_KEY = os.environ.get("CONTROL_API_KEY")
if not API_KEY:
    raise RuntimeError("Set CONTROL_API_KEY in the environment before starting")

SERVICES_FILE = os.environ.get("SERVICES_FILE", "/var/lib/ec2-control/services.json")
CWD_FILE = os.environ.get("CWD_FILE", "/var/lib/ec2-control/cwd")
DEFAULT_CWD = os.environ.get("DEFAULT_CWD", os.path.expanduser("~"))
UNIT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
CUSTOM_COMMAND_TIMEOUT = int(os.environ.get("CUSTOM_COMMAND_TIMEOUT", "60"))
MAX_PREVIEW_BYTES = 200_000

app = FastAPI(title="EC2 Bot Control API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


# ---------- services (phone-editable allow-list) ----------
#
# Each entry is {"label": ..., "scope": "system" | "user"}.
# "system" services are managed the normal way (systemctl, needs the
# polkit rule from setup). "user" services are ones created FROM the
# app itself (see /services/create) — they live under the backend's
# own user-level systemd instance, which needs no extra privileges at
# all to create, enable, or control.

def _seed_services() -> dict[str, dict]:
    raw = os.environ.get("SERVICES", "Bot:python-bot")
    services: dict[str, dict] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if ":" in pair:
            label, unit = pair.rsplit(":", 1)
        else:
            label, unit = pair, pair
        services[unit.strip()] = {"label": label.strip(), "scope": "system"}
    return services


def load_services() -> dict[str, dict]:
    if os.path.exists(SERVICES_FILE):
        with open(SERVICES_FILE) as f:
            raw = json.load(f)
        # Migrate the old {unit: "label"} shape transparently.
        migrated = False
        services: dict[str, dict] = {}
        for unit, value in raw.items():
            if isinstance(value, str):
                services[unit] = {"label": value, "scope": "system"}
                migrated = True
            else:
                services[unit] = value
        if migrated:
            save_services(services)
        return services
    seeded = _seed_services()
    save_services(seeded)
    return seeded


def save_services(services: dict[str, dict]):
    os.makedirs(os.path.dirname(SERVICES_FILE), exist_ok=True)
    with open(SERVICES_FILE, "w") as f:
        json.dump(services, f, indent=2)


def require_known_service(unit: str) -> dict:
    services = load_services()
    if unit not in services:
        raise HTTPException(status_code=400, detail=f"Unknown service '{unit}'")
    return services[unit]


def scope_flag(scope: str) -> list[str]:
    return ["--user"] if scope == "user" else []


# ---------- shared working directory ----------

def get_cwd() -> str:
    if os.path.exists(CWD_FILE):
        with open(CWD_FILE) as f:
            saved = f.read().strip()
            if saved and os.path.isdir(saved):
                return saved
    return DEFAULT_CWD


def set_cwd(path: str):
    os.makedirs(os.path.dirname(CWD_FILE), exist_ok=True)
    with open(CWD_FILE, "w") as f:
        f.write(path)


def resolve_path(path: str) -> str:
    base = get_cwd()
    if not path:
        return base
    full = path if path.startswith("/") else os.path.join(base, path)
    return os.path.normpath(full)


# ---------- helpers ----------

def check_key(x_api_key: str | None):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def run(cmd: list[str], timeout: int = 15) -> tuple[int, str]:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    output = (result.stdout or "") + (result.stderr or "")
    return result.returncode, output.strip()


def show_prop(unit: str, prop: str, scope: str = "system") -> str:
    code, out = run(["systemctl", *scope_flag(scope), "show", unit, "-p", prop, "--value"])
    return out.strip()


# ---------- models ----------

class ActionResponse(BaseModel):
    ok: bool
    message: str


class ServiceInfo(BaseModel):
    unit: str
    label: str
    scope: str


class AddServiceRequest(BaseModel):
    label: str
    unit: str


class CreateServiceRequest(BaseModel):
    label: str
    unit: str
    description: str = ""
    working_directory: str = ""
    exec_start: str
    # If provided, one or more 24-hour "HH:MM" times — creates a
    # scheduled Type=oneshot service + matching .timer, the same
    # pattern the rest of this backend is built around (see the study
    # guide, Chapter 2). If omitted, creates a long-running daemon
    # (Type=simple, Restart=on-failure) instead.
    schedule_times: list[str] = []


class CustomCommandsRequest(BaseModel):
    commands: list[str]
    # True for a full saved-script run — resets the shared directory back
    # to DEFAULT_CWD (equivalent to "cd ~") once the script fully
    # succeeds, so one script's internal navigation never leaks into an
    # unrelated script run later. Left False for one-off/test commands,
    # which should keep behaving like a normal persistent `cd`.
    reset_cwd_after: bool = False


class CommandResult(BaseModel):
    command: str
    exit_code: int
    output: str


class CustomCommandsResponse(BaseModel):
    results: list[CommandResult]
    stopped_early: bool


class CdRequest(BaseModel):
    path: str


class FileEntry(BaseModel):
    name: str
    is_dir: bool
    size: int | None = None


class WriteFileRequest(BaseModel):
    path: str
    content: str


# ---------- services ----------

@app.get("/services", response_model=list[ServiceInfo])
def list_services(x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    return [
        ServiceInfo(unit=u, label=v["label"], scope=v.get("scope", "system"))
        for u, v in load_services().items()
    ]


@app.post("/services", response_model=ActionResponse)
def add_service(body: AddServiceRequest, x_api_key: str | None = Header(default=None)):
    """Track an EXISTING systemd unit — doesn't create anything on the
    server, just adds it to the allow-list. Use /services/create to
    actually author and install a brand new unit instead."""
    check_key(x_api_key)
    unit = body.unit.strip()
    label = body.label.strip()
    if not unit or not label:
        raise HTTPException(status_code=400, detail="label and unit are both required")
    if not UNIT_NAME_RE.match(unit):
        raise HTTPException(
            status_code=400, detail="unit may only contain letters, numbers, '.', '-', '_'"
        )
    services = load_services()
    services[unit] = {"label": label, "scope": "system"}
    save_services(services)
    return ActionResponse(ok=True, message=f"Added {label} ({unit})")


USER_UNIT_DIR = os.path.expanduser("~/.config/systemd/user")


@app.post("/services/create", response_model=ActionResponse)
def create_service(body: CreateServiceRequest, x_api_key: str | None = Header(default=None)):
    """Actually author and install a brand new systemd unit — writes
    the .service (and, if scheduled, .timer) file, reloads systemd,
    and enables it. Runs entirely at the USER level (~/.config/systemd
    /user), which needs no root/polkit access at all — this is what
    makes it possible to do straight from the phone."""
    check_key(x_api_key)
    unit = body.unit.strip()
    label = body.label.strip()
    exec_start = body.exec_start.strip()
    if not unit or not label or not exec_start:
        raise HTTPException(status_code=400, detail="label, unit, and exec_start are required")
    if not UNIT_NAME_RE.match(unit):
        raise HTTPException(
            status_code=400, detail="unit may only contain letters, numbers, '.', '-', '_'"
        )

    os.makedirs(USER_UNIT_DIR, exist_ok=True)
    working_dir = body.working_directory.strip() or get_cwd()
    description = body.description.strip() or label

    service_lines = [
        "[Unit]",
        f"Description={description}",
        "",
        "[Service]",
    ]
    if body.schedule_times:
        service_lines += ["Type=oneshot"]
    else:
        service_lines += ["Type=simple", "Restart=on-failure"]
    service_lines += [
        f"WorkingDirectory={working_dir}",
        f"ExecStart={exec_start}",
    ]
    if not body.schedule_times:
        service_lines += ["", "[Install]", "WantedBy=default.target"]

    with open(os.path.join(USER_UNIT_DIR, f"{unit}.service"), "w") as f:
        f.write("\n".join(service_lines) + "\n")

    if body.schedule_times:
        timer_lines = ["[Unit]", f"Description={description} schedule", "", "[Timer]"]
        for t in body.schedule_times:
            t = t.strip()
            if not re.match(r"^\d{1,2}:\d{2}$", t):
                raise HTTPException(status_code=400, detail=f"Bad time '{t}', expected HH:MM")
            timer_lines.append(f"OnCalendar=*-*-* {t}:00")
        timer_lines += ["", "[Install]", "WantedBy=timers.target"]
        with open(os.path.join(USER_UNIT_DIR, f"{unit}.timer"), "w") as f:
            f.write("\n".join(timer_lines) + "\n")

    code, out = run(["systemctl", "--user", "daemon-reload"])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "daemon-reload failed")

    target = f"{unit}.timer" if body.schedule_times else unit
    code, out = run(["systemctl", "--user", "enable", "--now", target])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "enable failed")

    services = load_services()
    services[unit] = {"label": label, "scope": "user"}
    save_services(services)
    return ActionResponse(ok=True, message=f"Created and started {label} ({unit})")


@app.delete("/services/{unit}", response_model=ActionResponse)
def remove_service(unit: str, x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    services = load_services()
    if unit not in services:
        return ActionResponse(ok=True, message="Already not present")

    entry = services.pop(unit)
    save_services(services)

    if entry.get("scope") == "user":
        # This unit was created by this backend — fully uninstall it,
        # not just untrack it, so removing it from the app doesn't
        # leave an orphaned running service behind.
        run(["systemctl", "--user", "stop", f"{unit}.timer"])
        run(["systemctl", "--user", "disable", f"{unit}.timer"])
        run(["systemctl", "--user", "stop", unit])
        run(["systemctl", "--user", "disable", unit])
        for suffix in (".service", ".timer"):
            path = os.path.join(USER_UNIT_DIR, f"{unit}{suffix}")
            if os.path.exists(path):
                os.remove(path)
        run(["systemctl", "--user", "daemon-reload"])

    return ActionResponse(ok=True, message=f"Removed {entry['label']}")


@app.get("/status")
def status(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    entry = require_known_service(service)
    scope = entry.get("scope", "system")
    flag = scope_flag(scope)

    code, is_failed_out = run(["systemctl", *flag, "is-failed", service])
    code2, is_active_out = run(["systemctl", *flag, "is-active", service])

    currently_running = is_active_out.strip() in ("active", "activating")
    last_run_failed = is_failed_out.strip() == "failed"
    last_start = show_prop(service, "ExecMainStartTimestamp", scope)
    last_exit_code = show_prop(service, "ExecMainStatus", scope)

    timer_active_code, timer_active_out = run(["systemctl", *flag, "is-active", f"{service}.timer"])
    timer_armed = timer_active_out.strip() == "active"
    next_run = show_prop(f"{service}.timer", "NextElapseUSecRealtime", scope)

    return {
        "service": service,
        "label": entry["label"],
        "scope": scope,
        "currently_running": currently_running,
        "last_run_failed": last_run_failed,
        "last_run_started_at": last_start or None,
        "last_exit_code": last_exit_code or None,
        "timer_armed": timer_armed,
        "next_scheduled_run": next_run or None,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/logs")
def logs(
    service: str = Query(...),
    lines: int = Query(default=100, le=1000),
    x_api_key: str | None = Header(default=None),
):
    check_key(x_api_key)
    entry = require_known_service(service)
    flag = scope_flag(entry.get("scope", "system"))
    code, out = run(["journalctl", *flag, "-u", service, "-n", str(lines), "--no-pager"])
    return {"lines": out.splitlines()}


@app.post("/run-now", response_model=ActionResponse)
def run_now(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    entry = require_known_service(service)
    flag = scope_flag(entry.get("scope", "system"))
    code, out = run(["systemctl", *flag, "start", service])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "run failed")
    return ActionResponse(ok=True, message=f"{service} triggered")


@app.post("/restart", response_model=ActionResponse)
def restart(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    entry = require_known_service(service)
    flag = scope_flag(entry.get("scope", "system"))
    code, out = run(["systemctl", *flag, "restart", service])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "restart failed")
    return ActionResponse(ok=True, message=f"{service} restarted")


@app.post("/pause-schedule", response_model=ActionResponse)
def pause_schedule(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    entry = require_known_service(service)
    flag = scope_flag(entry.get("scope", "system"))
    code, out = run(["systemctl", *flag, "stop", f"{service}.timer"])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "pause failed")
    return ActionResponse(ok=True, message=f"{service} schedule paused")


@app.post("/resume-schedule", response_model=ActionResponse)
def resume_schedule(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    entry = require_known_service(service)
    flag = scope_flag(entry.get("scope", "system"))
    code, out = run(["systemctl", *flag, "start", f"{service}.timer"])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "resume failed")
    return ActionResponse(ok=True, message=f"{service} schedule resumed")


# ---------- custom commands (cwd-aware, cd persists) ----------

@app.post("/run-custom", response_model=CustomCommandsResponse)
def run_custom(body: CustomCommandsRequest, x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    results: list[CommandResult] = []
    stopped_early = False
    for cmd_str in body.commands:
        stripped = cmd_str.strip()

        # Handle `cd` specially — a subprocess's cwd change doesn't
        # survive past that one process, so we track it ourselves and
        # apply it to every subsequent command (and the file browser).
        if stripped == "cd" or stripped.startswith("cd "):
            target_arg = stripped[2:].strip() or os.path.expanduser("~")
            target = resolve_path(target_arg)
            if os.path.isdir(target):
                set_cwd(target)
                results.append(
                    CommandResult(command=cmd_str, exit_code=0, output=f"Changed directory to {target}")
                )
            else:
                results.append(
                    CommandResult(command=cmd_str, exit_code=1, output=f"No such directory: {target}")
                )
                stopped_early = True
                break
            continue

        try:
            proc = subprocess.run(
                cmd_str,
                shell=True,
                capture_output=True,
                text=True,
                timeout=CUSTOM_COMMAND_TIMEOUT,
                cwd=get_cwd(),
            )
            output = (proc.stdout or "") + (proc.stderr or "")
            results.append(
                CommandResult(command=cmd_str, exit_code=proc.returncode, output=output.strip())
            )
            if proc.returncode != 0:
                stopped_early = True
                break
        except subprocess.TimeoutExpired:
            results.append(CommandResult(command=cmd_str, exit_code=-1, output="Timed out"))
            stopped_early = True
            break

    if body.reset_cwd_after and not stopped_early:
        set_cwd(DEFAULT_CWD)

    return CustomCommandsResponse(results=results, stopped_early=stopped_early)


# ---------- basic interactive terminal ----------
#
# Streams a real bash session's output live over a WebSocket and lets
# the app send typed lines back to its stdin. This is enough for plain
# prompts (y/n, "type your name") since those just block on a normal
# stdin read — it is NOT a full terminal: there's no PTY, so tools that
# specifically require a real terminal (arrow-key menus like Vite's
# template picker) will not render correctly, and may refuse to run
# interactively at all. See the README's Limitations section.

@app.websocket("/terminal/ws")
async def terminal_ws(websocket: WebSocket, key: str = ""):
    if key != API_KEY:
        await websocket.close(code=4401)
        return
    await websocket.accept()

    # A real pseudo-terminal, not a plain pipe. This matters: only a
    # genuine PTY makes bash's readline active — history navigation via
    # arrow keys, Tab-completion, and Ctrl+C actually interrupting the
    # running command all depend on the kernel's tty line discipline,
    # which a plain subprocess pipe simply doesn't have.
    start_dir = get_cwd()
    master_fd, slave_fd = pty.openpty()
    pid = os.fork()
    if pid == 0:
        # In the child: detach into a new session so this pty becomes
        # our controlling terminal, then become bash.
        os.close(master_fd)
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        try:
            os.chdir(start_dir)
        except OSError:
            pass
        os.execvp("/bin/bash", ["/bin/bash"])
        os._exit(1)  # only reached if execvp itself fails
    os.close(slave_fd)

    loop = asyncio.get_event_loop()

    def reader():
        try:
            while True:
                r, _, _ = select.select([master_fd], [], [], 0.2)
                if master_fd not in r:
                    continue
                try:
                    chunk = os.read(master_fd, 1024)
                except OSError:
                    break  # child exited, pty closed
                if not chunk:
                    break
                asyncio.run_coroutine_threadsafe(
                    websocket.send_text(chunk.decode(errors="replace")), loop
                )
        except Exception:
            pass

    threading.Thread(target=reader, daemon=True).start()

    try:
        while True:
            data = await websocket.receive_text()
            # Raw bytes straight to the pty — a typed line with Enter,
            # or a special key's escape sequence (arrow keys, Tab, Ctrl+C,
            # etc.), makes no difference here: the pty's line discipline
            # is what gives each of these its real meaning, the same way
            # it would in any other terminal.
            os.write(master_fd, data.encode())
    except WebSocketDisconnect:
        pass
    finally:
        # Read back the session's REAL final directory (via /proc,
        # authoritative regardless of how it got there — cd, pushd,
        # subshells, anything) and persist it, so the file browser and
        # custom commands pick up where this session left off.
        try:
            real_cwd = os.readlink(f"/proc/{pid}/cwd")
            set_cwd(real_cwd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass


# ---------- file browser ----------

@app.get("/files/pwd")
def files_pwd(x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    return {"path": get_cwd()}


@app.post("/files/cd", response_model=ActionResponse)
def files_cd(body: CdRequest, x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    target = resolve_path(body.path)
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")
    set_cwd(target)
    return ActionResponse(ok=True, message=target)


@app.get("/files/list")
def files_list(path: str = Query(default=""), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    target = resolve_path(path) if path else get_cwd()
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")
    entries: list[dict] = []
    try:
        for name in sorted(os.listdir(target)):
            full = os.path.join(target, name)
            try:
                is_dir = os.path.isdir(full)
                size = None if is_dir else os.path.getsize(full)
                entries.append({"name": name, "is_dir": is_dir, "size": size})
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"path": target, "entries": entries}


@app.get("/files/read")
def files_read(path: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    target = resolve_path(path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=400, detail=f"Not a file: {target}")
    size = os.path.getsize(target)
    if size > MAX_PREVIEW_BYTES:
        return {"path": target, "truncated": True, "content": "File too large to preview (>200KB)."}
    try:
        with open(target, "r", errors="replace") as f:
            content = f.read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"path": target, "truncated": False, "content": content}


@app.post("/files/write", response_model=ActionResponse)
def files_write(body: WriteFileRequest, x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    target = resolve_path(body.path)
    try:
        with open(target, "w") as f:
            f.write(body.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return ActionResponse(ok=True, message=f"Saved {target}")


@app.get("/files/download")
def files_download(path: str = Query(...), x_api_key: str | None = Header(default=None)):
    """Raw file bytes with a guessed content type — used by the app's
    'Open With' flow, which downloads the file locally then hands it to
    the phone's native app chooser. Unlike /files/read, this works for
    any file type (images, PDFs, etc.), not just text."""
    check_key(x_api_key)
    target = resolve_path(path)
    if not os.path.isfile(target):
        raise HTTPException(status_code=400, detail=f"Not a file: {target}")
    mime, _ = mimetypes.guess_type(target)
    return FileResponse(
        target, media_type=mime or "application/octet-stream", filename=os.path.basename(target)
    )


@app.get("/health")
def health():
    return {"ok": True}
