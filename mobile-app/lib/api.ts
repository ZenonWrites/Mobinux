import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

// Legacy single-server keys, kept only so existing installs migrate
// forward automatically instead of losing their saved connection.
const LEGACY_BASE_URL_KEY = "ec2_control_base_url";
const LEGACY_API_KEY_KEY = "ec2_control_api_key";

const SERVERS_KEY = "ec2_control_servers";
const ACTIVE_SERVER_KEY = "ec2_control_active_server_id";
const SCRIPTS_KEY = "ec2_control_scripts";

export type ServerProfile = { id: string; name: string; baseUrl: string; apiKey: string };

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listServers(): Promise<ServerProfile[]> {
  const raw = await SecureStore.getItemAsync(SERVERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function persistServers(servers: ServerProfile[]) {
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
}

export async function getActiveServerId(): Promise<string | null> {
  return (await SecureStore.getItemAsync(ACTIVE_SERVER_KEY)) || null;
}

export async function setActiveServerId(id: string) {
  await SecureStore.setItemAsync(ACTIVE_SERVER_KEY, id);
}

export async function getActiveServer(): Promise<ServerProfile | null> {
  const servers = await listServers();
  const id = await getActiveServerId();
  return servers.find((s) => s.id === id) ?? null;
}

export async function addServer(
  name: string,
  baseUrl: string,
  apiKey: string
): Promise<ServerProfile> {
  const servers = await listServers();
  const profile: ServerProfile = { id: genId(), name, baseUrl, apiKey };
  await persistServers([...servers, profile]);
  const activeId = await getActiveServerId();
  if (!activeId) await setActiveServerId(profile.id);
  return profile;
}

export async function updateServer(id: string, fields: Partial<Omit<ServerProfile, "id">>) {
  const servers = await listServers();
  await persistServers(servers.map((s) => (s.id === id ? { ...s, ...fields } : s)));
}

export async function deleteServer(id: string) {
  const servers = await listServers();
  const next = servers.filter((s) => s.id !== id);
  await persistServers(next);
  const activeId = await getActiveServerId();
  if (activeId === id) {
    if (next.length > 0) await setActiveServerId(next[0].id);
    else await SecureStore.deleteItemAsync(ACTIVE_SERVER_KEY);
  }
}

// One-time migration from the old single-server storage, so an existing
// install doesn't lose its saved connection when this update lands.
export async function migrateLegacyConfig(): Promise<void> {
  const servers = await listServers();
  if (servers.length > 0) return;
  const legacyUrl = await SecureStore.getItemAsync(LEGACY_BASE_URL_KEY);
  const legacyKey = await SecureStore.getItemAsync(LEGACY_API_KEY_KEY);
  if (legacyUrl && legacyKey) {
    await addServer("My EC2", legacyUrl, legacyKey);
  }
}

// Used internally by request() below — resolves to whichever server is
// currently active.
export async function getConfig() {
  const active = await getActiveServer();
  return { baseUrl: active?.baseUrl ?? null, apiKey: active?.apiKey ?? null };
}

// A "script" is a named group of shell command lines that runs as one
// unit — one tap on its home-screen card runs every line in order.
// Scripts are per-device, not per-server, since they're just saved text.
export type Script = { id: string; name: string; commands: string[] };

export async function getScripts(): Promise<Script[]> {
  const raw = await SecureStore.getItemAsync(SCRIPTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveScripts(scripts: Script[]) {
  await SecureStore.setItemAsync(SCRIPTS_KEY, JSON.stringify(scripts));
}

async function request(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: any) {
  const { baseUrl, apiKey } = await getConfig();
  if (!baseUrl || !apiKey) {
    throw new Error("No server selected — add or pick one first");
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export type ServiceInfo = { unit: string; label: string };

export type Status = {
  service: string;
  label: string;
  currently_running: boolean;
  last_run_failed: boolean;
  last_run_started_at: string | null;
  last_exit_code: string | null;
  timer_armed: boolean;
  next_scheduled_run: string | null;
  checked_at: string;
};

export type CommandResult = { command: string; exit_code: number; output: string };
export type CustomCommandsResponse = { results: CommandResult[]; stopped_early: boolean };

export const getServices = (): Promise<ServiceInfo[]> => request("/services");
export const addService = (label: string, unit: string) =>
  request("/services", "POST", { label, unit });
export const removeService = (unit: string) =>
  request(`/services/${encodeURIComponent(unit)}`, "DELETE");

export const getStatus = (service: string): Promise<Status> =>
  request(`/status?service=${encodeURIComponent(service)}`);
export const getLogs = (service: string, lines = 100): Promise<{ lines: string[] }> =>
  request(`/logs?service=${encodeURIComponent(service)}&lines=${lines}`);

export const runNow = (service: string) =>
  request(`/run-now?service=${encodeURIComponent(service)}`, "POST");
export const restartService = (service: string) =>
  request(`/restart?service=${encodeURIComponent(service)}`, "POST");
export const pauseSchedule = (service: string) =>
  request(`/pause-schedule?service=${encodeURIComponent(service)}`, "POST");
export const resumeSchedule = (service: string) =>
  request(`/resume-schedule?service=${encodeURIComponent(service)}`, "POST");

export const runCustomCommands = (commands: string[]): Promise<CustomCommandsResponse> =>
  request("/run-custom", "POST", { commands });

// File browser — shares one "current directory" with custom commands on
// whichever server is currently active, so a `cd` line run as a command
// moves the browser too, and vice versa.
export type FileEntry = { name: string; is_dir: boolean; size: number | null };

export const getPwd = (): Promise<{ path: string }> => request("/files/pwd");
export const cdTo = (path: string) => request("/files/cd", "POST", { path });
export const listFiles = (path?: string): Promise<{ path: string; entries: FileEntry[] }> =>
  request(`/files/list${path ? `?path=${encodeURIComponent(path)}` : ""}`);
export const readFile = (
  path: string
): Promise<{ path: string; truncated: boolean; content: string }> =>
  request(`/files/read?path=${encodeURIComponent(path)}`);
export const writeFile = (path: string, content: string) =>
  request("/files/write", "POST", { path, content });

// Extensions that are actually text, mapped to "text/plain" explicitly.
// Auto-guessed MIME types (e.g. "application/json" for .json) cause two
// problems: many text editors only register as share targets for
// text/plain specifically (so they don't even appear in the chooser),
// and some open but fail to import the content correctly. A small set
// of genuinely binary types get their real MIME type; everything else
// defaults to text/plain since that's what this project's files mostly
// are (source code, configs, logs).
const BINARY_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

function mimeTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_MIME_BY_EXT[ext] ?? "text/plain";
}

// Downloads the file to the phone, then hands it to the native
// "Open with" / share sheet so you can view or edit it in whatever app
// on your phone handles that file type.
export async function openFileExternally(path: string): Promise<void> {
  const { baseUrl, apiKey } = await getConfig();
  if (!baseUrl || !apiKey) {
    throw new Error("No server selected — add or pick one first");
  }
  const filename = path.split("/").pop() || "file";
  const localUri = FileSystem.cacheDirectory + filename;
  const downloadRes = await FileSystem.downloadAsync(
    `${baseUrl}/files/download?path=${encodeURIComponent(path)}`,
    localUri,
    { headers: { "x-api-key": apiKey } }
  );
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error("Opening files isn't available on this device");
  }
  await Sharing.shareAsync(downloadRes.uri, {
    mimeType: mimeTypeFor(filename),
    dialogTitle: filename,
  });
}
