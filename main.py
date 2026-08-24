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
import re
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

def _seed_services() -> dict[str, str]:
    raw = os.environ.get("SERVICES", "Bot:python-bot")
    services: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if ":" in pair:
            label, unit = pair.rsplit(":", 1)
        else:
            label, unit = pair, pair
        services[unit.strip()] = label.strip()
    return services


def load_services() -> dict[str, str]:
    if os.path.exists(SERVICES_FILE):
        with open(SERVICES_FILE) as f:
            return json.load(f)
    seeded = _seed_services()
    save_services(seeded)
    return seeded


def save_services(services: dict[str, str]):
    os.makedirs(os.path.dirname(SERVICES_FILE), exist_ok=True)
    with open(SERVICES_FILE, "w") as f:
        json.dump(services, f, indent=2)


def require_known_service(unit: str) -> str:
    if unit not in load_services():
        raise HTTPException(status_code=400, detail=f"Unknown service '{unit}'")
    return unit


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


def show_prop(unit: str, prop: str) -> str:
    code, out = run(["systemctl", "show", unit, "-p", prop, "--value"])
    return out.strip()


# ---------- models ----------

class ActionResponse(BaseModel):
    ok: bool
    message: str


class ServiceInfo(BaseModel):
    unit: str
    label: str


class AddServiceRequest(BaseModel):
    label: str
    unit: str


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
    return [ServiceInfo(unit=u, label=l) for u, l in load_services().items()]


@app.post("/services", response_model=ActionResponse)
def add_service(body: AddServiceRequest, x_api_key: str | None = Header(default=None)):
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
    services[unit] = label
    save_services(services)
    return ActionResponse(ok=True, message=f"Added {label} ({unit})")


@app.delete("/services/{unit}", response_model=ActionResponse)
def remove_service(unit: str, x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    services = load_services()
    if unit in services:
        label = services.pop(unit)
        save_services(services)
        return ActionResponse(ok=True, message=f"Removed {label}")
    return ActionResponse(ok=True, message="Already not present")


@app.get("/status")
def status(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    require_known_service(service)
    label = load_services()[service]

    code, is_failed_out = run(["systemctl", "is-failed", service])
    code2, is_active_out = run(["systemctl", "is-active", service])

    currently_running = is_active_out.strip() in ("active", "activating")
    last_run_failed = is_failed_out.strip() == "failed"
    last_start = show_prop(service, "ExecMainStartTimestamp")
    last_exit_code = show_prop(service, "ExecMainStatus")

    timer_active_code, timer_active_out = run(["systemctl", "is-active", f"{service}.timer"])
    timer_armed = timer_active_out.strip() == "active"
    next_run = show_prop(f"{service}.timer", "NextElapseUSecRealtime")

    return {
        "service": service,
        "label": label,
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
    require_known_service(service)
    code, out = run(["journalctl", "-u", service, "-n", str(lines), "--no-pager"])
    return {"lines": out.splitlines()}


@app.post("/run-now", response_model=ActionResponse)
def run_now(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    require_known_service(service)
    code, out = run(["systemctl", "start", service])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "run failed")
    return ActionResponse(ok=True, message=f"{service} triggered")


@app.post("/restart", response_model=ActionResponse)
def restart(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    require_known_service(service)
    code, out = run(["systemctl", "restart", service])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "restart failed")
    return ActionResponse(ok=True, message=f"{service} restarted")


@app.post("/pause-schedule", response_model=ActionResponse)
def pause_schedule(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    require_known_service(service)
    code, out = run(["systemctl", "stop", f"{service}.timer"])
    if code != 0:
        raise HTTPException(status_code=500, detail=out or "pause failed")
    return ActionResponse(ok=True, message=f"{service} schedule paused")


@app.post("/resume-schedule", response_model=ActionResponse)
def resume_schedule(service: str = Query(...), x_api_key: str | None = Header(default=None)):
    check_key(x_api_key)
    require_known_service(service)
    code, out = run(["systemctl", "start", f"{service}.timer"])
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

    proc = subprocess.Popen(
        ["/bin/bash"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=get_cwd(),
        bufsize=0,
    )

    loop = asyncio.get_event_loop()

    def reader():
        try:
            while True:
                chunk = proc.stdout.read(1024)
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
            line = await websocket.receive_text()

            # Mirror `cd` into the shared directory file too, so the
            # file browser and future custom-command runs stay roughly
            # in sync with directory changes made interactively here.
            # Best-effort only — see the README's Limitations section.
            stripped = line.strip()
            if stripped == "cd" or stripped.startswith("cd "):
                target_arg = stripped[2:].strip() or os.path.expanduser("~")
                target = resolve_path(target_arg)
                if os.path.isdir(target):
                    set_cwd(target)

            if proc.stdin:
                proc.stdin.write((line + "\n").encode())
                proc.stdin.flush()
    except WebSocketDisconnect:
        pass
    finally:
        proc.terminate()


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
