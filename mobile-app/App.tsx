import React, { useEffect, useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Keyboard,
  FlatList,
  BackHandler,
  Modal,
} from "react-native";
import {
  getServices,
  addService,
  createService,
  removeService,
  getStatus,
  getLogs,
  runNow,
  restartService,
  pauseSchedule,
  resumeSchedule,
  runCustomCommands,
  getScripts,
  saveScripts,
  getPwd,
  cdTo,
  listFiles,
  readFile,
  writeFile,
  openFileExternally,
  getTerminalWsUrl,
  listServers,
  addServer,
  updateServer,
  deleteServer,
  getActiveServerId,
  setActiveServerId,
  migrateLegacyConfig,
  ServiceInfo,
  Status,
  Script,
  CustomCommandsResponse,
  FileEntry,
  ServerProfile,
} from "./lib/api";
import { tokenizeLine, langForFilename } from "./lib/highlight";

type Screen = "home" | "logs" | "servers" | "serverForm" | "scriptForm" | "files" | "terminal";

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [showExitModal, setShowExitModal] = useState(false);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [scripts, setScripts] = useState<Script[]>([]);
  const [scriptResults, setScriptResults] = useState<Record<string, CustomCommandsResponse>>({});
  const [busyScriptId, setBusyScriptId] = useState<string | null>(null);
  const [editingScript, setEditingScript] = useState<Script | null>(null);
  const [logService, setLogService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyService, setBusyService] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasActiveServer, setHasActiveServer] = useState(false);
  const [activeServerName, setActiveServerName] = useState<string>("");
  const [editingServer, setEditingServer] = useState<ServerProfile | null>(null);

  const checkActiveServer = useCallback(async () => {
    const servers = await listServers();
    const activeId = await getActiveServerId();
    const active = servers.find((s) => s.id === activeId) ?? null;
    setHasActiveServer(!!active);
    setActiveServerName(active?.name ?? "");
    return !!active;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await getServices();
      setServices(list);
      const entries = await Promise.all(
        list.map(async (s) => {
          try {
            const st = await getStatus(s.unit);
            return [s.unit, st] as const;
          } catch {
            return null;
          }
        })
      );
      const next: Record<string, Status> = {};
      for (const e of entries) {
        if (e) next[e[0]] = e[1];
      }
      setStatuses(next);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
    const s = await getScripts();
    setScripts(s);
  }, []);

  useEffect(() => {
    (async () => {
      await migrateLegacyConfig();
      await checkActiveServer();
      setReady(true);
    })();
  }, [checkActiveServer]);

  useEffect(() => {
    if (!ready || !hasActiveServer) return;
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [ready, hasActiveServer, refresh]);

  const confirmAndRun = (
    title: string,
    message: string,
    unit: string,
    action: (unit: string) => Promise<any>
  ) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: title,
        style: "destructive",
        onPress: async () => {
          setBusyService(unit);
          try {
            await action(unit);
            await refresh();
          } catch (e: any) {
            Alert.alert("Failed", e.message);
          } finally {
            setBusyService(null);
          }
        },
      },
    ]);
  };

  const runScript = (script: Script) => {
    Alert.alert(
      script.name,
      `Run ${script.commands.length} command(s) in order, one tap, no further confirmation per line?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Run",
          style: "destructive",
          onPress: async () => {
            setBusyScriptId(script.id);
            try {
              const res = await runCustomCommands(script.commands, true);
              setScriptResults((prev) => ({ ...prev, [script.id]: res }));
            } catch (e: any) {
              Alert.alert("Failed", e.message);
            } finally {
              setBusyScriptId(null);
            }
          },
        },
      ]
    );
  };

  const persistScripts = async (next: Script[]) => {
    setScripts(next);
    await saveScripts(next);
  };

  const switchToHomeAndRefresh = async () => {
    const ok = await checkActiveServer();
    setScreen("home");
    if (ok) refresh();
  };

  // Teaches Android's hardware/gesture back button about the app's own
  // screens — without this, React Native has no navigation library
  // wired up to intercept it, so back falls through to the OS default
  // of closing the app entirely, from any screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!hasActiveServer) return false; 
      if (screen === "servers") {
        setScreen("home");
        return true;
      }
      if (screen === "serverForm") {
        setScreen("servers");
        return true;
      }
      if (screen === "files") {
        setScreen("home");
        return true;
      }
      if (screen === "scriptForm") {
        setEditingScript(null);
        setScreen("home");
        return true;
      }
      if (screen === "logs") {
        setScreen("home");
        setLogService(null);
        return true;
      }
      
      // Trigger custom modal instead of native Alert
      setShowExitModal(true);
      return true; 
    });
    return () => sub.remove();
  }, [screen, hasActiveServer]);

  if (!ready) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  if (!hasActiveServer) {
    return (
      <ServerFormScreen
        initial={null}
        onCancel={undefined}
        onSaved={switchToHomeAndRefresh}
      />
    );
  }

  if (screen === "servers") {
    return (
      <ServersScreen
        onBack={() => setScreen("home")}
        onSwitched={switchToHomeAndRefresh}
        onAddNew={() => {
          setEditingServer(null);
          setScreen("serverForm");
        }}
        onEdit={(server) => {
          setEditingServer(server);
          setScreen("serverForm");
        }}
      />
    );
  }
  if (screen === "serverForm") {
    return (
      <ServerFormScreen
        initial={editingServer}
        onCancel={() => setScreen("servers")}
        onSaved={switchToHomeAndRefresh}
      />
    );
  }
  if (screen === "files") {
    return <FilesScreen onBack={() => setScreen("home")} />;
  }
  if (screen === "terminal") {
    return <TerminalScreen onBack={() => setScreen("home")} />;
  }
  if (screen === "scriptForm") {
    return (
      <ScriptFormScreen
        initial={editingScript}
        onCancel={() => {
          setEditingScript(null);
          setScreen("home");
        }}
        onSave={async (script) => {
          const exists = scripts.some((s) => s.id === script.id);
          const next = exists
            ? scripts.map((s) => (s.id === script.id ? script : s))
            : [...scripts, script];
          await persistScripts(next);
          setEditingScript(null);
          setScreen("home");
        }}
        onDelete={async (id) => {
          await persistScripts(scripts.filter((s) => s.id !== id));
          setEditingScript(null);
          setScreen("home");
        }}
      />
    );
  }
  if (screen === "logs" && logService) {
    return (
      <LogsScreen
        service={logService}
        onBack={() => {
          setScreen("home");
          setLogService(null);
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        contentContainerStyle={styles.scroll}
      >
        <View style={styles.header}>
          <HeaderButton label="=" onPress={() => setScreen("files")} />
          <Text style={styles.title}>Bot Control</Text>
          <HeaderButton label="Settings" onPress={() => setScreen("servers")} />
        </View>

        <Pressable style={styles.activeServerBar} onPress={() => setScreen("servers")}>
          <Text style={styles.activeServerText}>Connected: {activeServerName}</Text>
          <Text style={styles.activeServerSwitch}>Switch</Text>
        </Pressable>

        {/* Terminal entry point hidden for now — the plain-text output
            view can't interpret ANSI escape codes, so a color-enabled
            interactive prompt (needed for arrow-key history to work at
            all) renders as visible garbage. Re-enable once TerminalScreen
            is rebuilt around a real terminal renderer (xterm.js in a
            WebView is the planned approach) — the screen and backend
            WebSocket endpoint are both left intact below.
        <Pressable style={styles.terminalEntryButton} onPress={() => setScreen("terminal")}>
          <Text style={styles.terminalEntryText}>Open Terminal</Text>
        </Pressable>
        */}

        {error && (
          <View style={[styles.card, styles.cardDown]}>
            <Text style={styles.cardMeta}>{error}</Text>
          </View>
        )}

        {services.length === 0 && !error && <ActivityIndicator style={{ marginTop: 24 }} />}

        {services.map((svc) => {
          const st = statuses[svc.unit];
          const busy = busyService === svc.unit;
          return (
            <View key={svc.unit} style={styles.serviceCard}>
              <Pressable
                onLongPress={() =>
                  Alert.alert(
                    "Remove service",
                    `Remove ${svc.label} from this app? (Doesn't touch anything on the server itself.)`,
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: async () => {
                          try {
                            await removeService(svc.unit);
                            await refresh();
                          } catch (e: any) {
                            Alert.alert("Failed", e.message);
                          }
                        },
                      },
                    ]
                  )
                }
              >
                <Text style={styles.serviceLabel}>
                  {svc.label}{" "}
                  <Text style={styles.scopeBadge}>
                    {svc.scope === "user" ? "(created here)" : "(system)"}
                  </Text>
                </Text>
              </Pressable>
              <View
                style={[styles.statusPill, st?.last_run_failed ? styles.statusBad : styles.statusOk]}
              >
                <Text style={styles.statusPillText}>
                  {!st
                    ? "Loading..."
                    : st.currently_running
                    ? "Running now"
                    : st.last_run_failed
                    ? "Last run failed"
                    : "OK"}
                </Text>
              </View>
              {st && (
                <>
                  <Text style={styles.cardMeta}>Started: {formatWhen(st.last_run_started_at)}</Text>
                  <Text style={styles.cardMeta}>
                    Schedule: {st.timer_armed ? "armed" : "PAUSED"}
                    {st.next_scheduled_run ? ` · next ${formatWhen(st.next_scheduled_run)}` : ""}
                  </Text>
                </>
              )}

              <View style={styles.buttonGrid}>
                <BigButton
                  label="Run Now"
                  color="#3b82f6"
                  disabled={busy}
                  onPress={() =>
                    confirmAndRun("Run Now", `Trigger an immediate run of ${svc.label}?`, svc.unit, runNow)
                  }
                />
                <BigButton
                  label="Restart"
                  color="#8b5cf6"
                  disabled={busy}
                  onPress={() =>
                    confirmAndRun("Restart", `Restart ${svc.label}?`, svc.unit, restartService)
                  }
                />
                <BigButton
                  label="Pause"
                  color="#ef4444"
                  disabled={busy}
                  onPress={() =>
                    confirmAndRun("Pause", `Pause ${svc.label}'s schedule?`, svc.unit, pauseSchedule)
                  }
                />
                <BigButton
                  label="Resume"
                  color="#22c55e"
                  disabled={busy}
                  onPress={() =>
                    confirmAndRun("Resume", `Resume ${svc.label}'s schedule?`, svc.unit, resumeSchedule)
                  }
                />
              </View>

              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  setLogService(svc.unit);
                  setScreen("logs");
                }}
              >
                <Text style={styles.secondaryButtonText}>View logs</Text>
              </Pressable>

              {busy && <ActivityIndicator style={{ marginTop: 12 }} />}
            </View>
          );
        })}

        <AddServiceCard onAdded={refresh} />

        <Text style={styles.sectionTitle}>Scripts</Text>

        {scripts.map((script) => {
          const busy = busyScriptId === script.id;
          const res = scriptResults[script.id];
          return (
            <Pressable
              key={script.id}
              style={styles.scriptCard}
              onPress={() => {
                setEditingScript(script);
                setScreen("scriptForm");
              }}
              onLongPress={() =>
                Alert.alert("Delete script", `Delete "${script.name}"?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => persistScripts(scripts.filter((s) => s.id !== script.id)),
                  },
                ])
              }
            >
              <View style={styles.scriptCardHeader}>
                <Text style={styles.serviceLabel}>{script.name}</Text>
                <Pressable
                  style={[styles.runChip, busy && { opacity: 0.5 }]}
                  disabled={busy}
                  onPress={(e) => {
                    e.stopPropagation?.();
                    runScript(script);
                  }}
                >
                  <Text style={styles.runChipText}>{busy ? "Running..." : "Run"}</Text>
                </Pressable>
              </View>
              <Text style={styles.cardMeta}>
                {script.commands.length} command{script.commands.length === 1 ? "" : "s"} · tap to
                edit, long-press to delete
              </Text>
              {res && (
                <View style={{ marginTop: 10 }}>
                  <Text style={styles.cardMeta}>
                    {res.stopped_early ? "Stopped early:" : "All ran successfully"}
                  </Text>
                  {res.results.map((r, i) => (
                    <View key={i} style={styles.resultBox}>
                      <Text style={[styles.resultCommand, r.exit_code !== 0 && { color: "#ef4444" }]}>
                        {r.command} (exit {r.exit_code})
                      </Text>
                      {!!r.output && <Text style={styles.logLine}>{r.output}</Text>}
                    </View>
                  ))}
                </View>
              )}
            </Pressable>
          );
        })}

        <Pressable
          style={styles.commandsButton}
          onPress={() => {
            setEditingScript(null);
            setScreen("scriptForm");
          }}
        >
          <Text style={styles.commandsButtonText}>+ New Script</Text>
        </Pressable>
      </ScrollView>
      
      {/* --- Custom Exit Modal --- */}
      <Modal
        transparent={true}
        visible={showExitModal}
        animationType="fade"
        onRequestClose={() => setShowExitModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Exit?</Text>
            
            <View style={styles.modalButtonGroup}>
              {/* YES Button - Left side */}
              <Pressable
                style={styles.modalButton}
                onPress={() => BackHandler.exitApp()}
              >
                <Text style={styles.modalButtonText}>Yes</Text>
              </Pressable>
              
              {/* NO Button - Right side */}
              <Pressable
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={() => setShowExitModal(false)}
              >
                <Text style={styles.modalButtonText}>No</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={styles.headerButton}
    >
      <Text style={styles.headerButtonText}>{label}</Text>
    </Pressable>
  );
}

function BigButton({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={[styles.gridButton, { backgroundColor: color, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

function LogsScreen({ service, onBack }: { service: string; onBack: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getLogs(service, 150);
      setLines(res.lines);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <HeaderButton label="Back" onPress={onBack} />
        <Text style={styles.title}>Logs</Text>
        <HeaderButton label="Refresh" onPress={load} />
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={[styles.cardMeta, { paddingHorizontal: 16 }]}>{error}</Text>
      ) : (
        <ScrollView style={styles.logBox}>
          {lines.map((line, i) => (
            <Text key={i} style={styles.logLine}>
              {line}
            </Text>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ScriptFormScreen({
  initial,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: Script | null;
  onCancel: () => void;
  onSave: (script: Script) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [lines, setLines] = useState<string[]>(initial?.commands ?? [""]);
  const [runningLine, setRunningLine] = useState<number | null>(null);

  const updateLine = (i: number, value: string) => {
    setLines((prev) => prev.map((l, idx) => (idx === i ? value : l)));
  };

  const removeLine = (i: number) => {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  };

  const runLine = async (i: number) => {
    const cmd = lines[i].trim();
    if (!cmd) return;
    setRunningLine(i);
    try {
      const res = await runCustomCommands([cmd]);
      const r = res.results[0];
      Alert.alert(
        r.exit_code === 0 ? "Ran successfully" : `Failed (exit ${r.exit_code})`,
        r.output || "(no output)"
      );
    } catch (e: any) {
      Alert.alert("Failed", e.message);
    } finally {
      setRunningLine(null);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <HeaderButton label="Cancel" onPress={onCancel} />
          <Text style={styles.title}>{initial ? "Edit Script" : "New Script"}</Text>
          <View style={{ width: 70 }} />
        </View>

        <Text style={styles.cardLabel}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Basic Python Server Start"
          placeholderTextColor="#6b7280"
          style={[styles.input, { marginTop: 8, marginBottom: 16 }]}
        />

        <Text style={styles.cardLabel}>Commands, in order</Text>
        {lines.map((line, i) => (
          <View key={i} style={styles.commandLineRow}>
            <View style={styles.commandLineBadge}>
              <Text style={styles.commandLineBadgeText}>{i + 1}</Text>
            </View>
            <TextInput
              value={line}
              onChangeText={(v) => updateLine(i, v)}
              placeholder="e.g. source env/bin/activate"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              style={styles.commandLineInput}
            />
            <Pressable
              style={[styles.lineIconButton, { backgroundColor: "#1e3a8a" }]}
              disabled={runningLine === i}
              onPress={() => runLine(i)}
            >
              <Text style={styles.lineIconText}>{runningLine === i ? "..." : "Run"}</Text>
            </Pressable>
            <Pressable
              style={[styles.lineIconButton, { backgroundColor: "#450a0a" }]}
              onPress={() => removeLine(i)}
            >
              <Text style={[styles.lineIconText, { color: "#ef4444" }]}>X</Text>
            </Pressable>
          </View>
        ))}

        <Pressable style={styles.addLineButton} onPress={() => setLines((prev) => [...prev, ""])}>
          <Text style={styles.secondaryButtonText}>+ Add Line</Text>
        </Pressable>

        <Pressable
          style={styles.saveButton}
          onPress={() => {
            const trimmedName = name.trim();
            const trimmedLines = lines.map((l) => l.trim()).filter(Boolean);
            if (!trimmedName || trimmedLines.length === 0) {
              Alert.alert("Missing info", "Give it a name and at least one command line.");
              return;
            }
            onSave({ id: initial?.id ?? newId(), name: trimmedName, commands: trimmedLines });
          }}
        >
          <Text style={styles.actionButtonText}>Save Script</Text>
        </Pressable>

        {initial && (
          <Pressable
            style={styles.deleteButton}
            onPress={() =>
              Alert.alert("Delete script", `Delete "${initial.name}"?`, [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => onDelete(initial.id) },
              ])
            }
          >
            <Text style={[styles.actionButtonText, { color: "#ef4444" }]}>Delete Script</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EditorScreen({ path, onBack }: { path: string; onBack: () => void }) {
  const filename = path.split("/").pop() || path;
  const lang = langForFilename(filename);

  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [jumpSelection, setJumpSelection] = useState<{ start: number; end: number } | undefined>(
    undefined
  );
  const inputRef = React.useRef<TextInput>(null);
  const scrollRef = React.useRef<ScrollView>(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (mode === "edit") {
        setMode("view");
        return true;
      }
      return false; // falls through to FilesScreen's handler, then App's
    });
    return () => sub.remove();
  }, [mode]);
  const scrollYRef = React.useRef(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Line height + top padding must match styles.editorInput exactly —
  // used to work out which line the cursor is on and where it sits.
  const LINE_HEIGHT = 20;
  const TOP_PADDING = 16;

  const lastCursorRef = React.useRef(0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
      scrollCursorIntoView(lastCursorRef.current);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [content]);

  const scrollCursorIntoView = (cursorIndex: number) => {
    lastCursorRef.current = cursorIndex;
    const lineIndex = content.slice(0, cursorIndex).split("\n").length - 1;
    const lineTop = TOP_PADDING + lineIndex * LINE_HEIGHT;
    const lineBottom = lineTop + LINE_HEIGHT;
    requestAnimationFrame(() => {
      if (!containerHeight) return;
      const margin = LINE_HEIGHT * 1.5 + 12;
      const visibleBottom = scrollYRef.current + containerHeight - keyboardHeight - margin;
      if (lineBottom > visibleBottom) {
        const target = scrollYRef.current + (lineBottom - visibleBottom);
        scrollRef.current?.scrollTo({ y: Math.max(target, 0), animated: true });
      }
    });
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await readFile(path);
        setContent(res.content);
        setTruncated(res.truncated);
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [path]);

  const save = async () => {
    setSaving(true);
    try {
      await writeFile(path, content);
      setMode("view");
    } catch (e: any) {
      Alert.alert("Couldn't save", e.message);
    } finally {
      setSaving(false);
    }
  };

  const lines = content.split("\n");
  const editorWidth = Math.max(
    360,
    Math.max(...lines.map((l) => l.length), 20) * 8.5
  );

  // --- find & replace (simple case-sensitive substring search) ---
  const matches = React.useMemo(() => {
    if (!findQuery) return [] as number[];
    const positions: number[] = [];
    let from = 0;
    while (true) {
      const idx = content.indexOf(findQuery, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + findQuery.length;
    }
    return positions;
  }, [content, findQuery]);

  const jumpToMatch = (idx: number) => {
    if (matches.length === 0) return;
    const clamped = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIndex(clamped);
    const start = matches[clamped];
    setJumpSelection({ start, end: start + findQuery.length });
    inputRef.current?.focus();
    // Release control back to the user after the jump lands, so a
    // controlled `selection` prop doesn't fight normal typing/cursor
    // movement afterward.
    setTimeout(() => setJumpSelection(undefined), 80);
  };

  const nextMatch = () => jumpToMatch(matchIndex + 1);
  const prevMatch = () => jumpToMatch(matchIndex - 1);

  const replaceCurrent = () => {
    if (matches.length === 0) return;
    const start = matches[matchIndex];
    const next = content.slice(0, start) + replaceQuery + content.slice(start + findQuery.length);
    setContent(next);
  };

  const replaceAll = () => {
    if (!findQuery) return;
    setContent(content.split(findQuery).join(replaceQuery));
  };

  const renderCodeLine = ({ item, index }: { item: string; index: number }) => {
    const tokens = tokenizeLine(item, lang);
    return (
      <View style={styles.codeLineRow}>
        <Text style={styles.codeLineNumber}>{index + 1}</Text>
        <Text style={styles.codeLineText}>
          {tokens.length === 0
            ? " "
            : tokens.map((t, j) => (
                <Text key={j} style={{ color: t.color }}>
                  {t.text}
                </Text>
              ))}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <HeaderButton
          label={mode === "edit" ? "Cancel" : "Back"}
          onPress={mode === "edit" ? () => setMode("view") : onBack}
        />
        <Text style={styles.title} numberOfLines={1}>
          {filename}
        </Text>
        {mode === "view" ? (
          <HeaderButton label="Edit" onPress={() => setMode("edit")} />
        ) : (
          <HeaderButton label={saving ? "..." : "Save"} onPress={save} />
        )}
      </View>

      {mode === "edit" && (
        <Pressable
          style={styles.findToggle}
          onPress={() => setShowFind((v) => !v)}
        >
          <Text style={styles.findToggleText}>
            {showFind ? "Hide Find & Replace" : "Find & Replace"}
          </Text>
        </Pressable>
      )}

      {mode === "edit" && showFind && (
        <View style={styles.findBar}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              value={findQuery}
              onChangeText={(v) => {
                setFindQuery(v);
                setMatchIndex(0);
              }}
              placeholder="Find"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              style={[styles.input, { flex: 1 }]}
            />
            <Text style={styles.cardMeta}>
              {matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0"}
            </Text>
            <Pressable style={styles.lineIconButton} onPress={prevMatch}>
              <Text style={styles.lineIconText}>Prev</Text>
            </Pressable>
            <Pressable style={styles.lineIconButton} onPress={nextMatch}>
              <Text style={styles.lineIconText}>Next</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8 }}>
            <TextInput
              value={replaceQuery}
              onChangeText={setReplaceQuery}
              placeholder="Replace with"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              style={[styles.input, { flex: 1 }]}
            />
            <Pressable style={styles.lineIconButton} onPress={replaceCurrent}>
              <Text style={styles.lineIconText}>Replace</Text>
            </Pressable>
            <Pressable style={[styles.lineIconButton, { backgroundColor: "#7c2d12" }]} onPress={replaceAll}>
              <Text style={styles.lineIconText}>All</Text>
            </Pressable>
          </View>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={[styles.cardMeta, { paddingHorizontal: 16 }]}>{error}</Text>
      ) : mode === "edit" ? (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: keyboardHeight > 0 ? keyboardHeight + LINE_HEIGHT * 2 : 0,
          }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
          onScroll={(e) => {
            scrollYRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
          <ScrollView horizontal keyboardDismissMode="on-drag">
            <TextInput
              ref={inputRef}
              value={content}
              onChangeText={setContent}
              onSelectionChange={(e) => scrollCursorIntoView(e.nativeEvent.selection.start)}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              {...(jumpSelection ? { selection: jumpSelection } : {})}
              style={[styles.editorInput, { width: editorWidth }]}
            />
          </ScrollView>
        </ScrollView>
      ) : (
        <>
          {truncated && (
            <Text style={[styles.cardMeta, { paddingHorizontal: 16 }]}>
              File is large — preview truncated. Editing will overwrite with only what's shown.
            </Text>
          )}
          <ScrollView horizontal style={{ flex: 1 }}>
            <FlatList
              data={lines}
              keyExtractor={(_, i) => String(i)}
              renderItem={renderCodeLine}
              style={{ minWidth: editorWidth }}
              contentContainerStyle={styles.codeListContent}
              initialNumToRender={40}
              maxToRenderPerBatch={40}
              windowSize={8}
              removeClippedSubviews
            />
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

function KeyButton({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={[styles.keyButton, danger && { borderColor: "#ef4444" }]}
      onPress={onPress}
    >
      <Text style={[styles.keyButtonText, danger && { color: "#ef4444" }]}>{label}</Text>
    </Pressable>
  );
}

function TerminalScreen({ onBack }: { onBack: () => void }) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const scrollRef = React.useRef<ScrollView>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await getTerminalWsUrl();
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => !cancelled && setConnected(true);
        ws.onmessage = (e) => {
          if (cancelled) return;
          setOutput((prev) => prev + e.data);
          requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
        };
        ws.onerror = () => !cancelled && setError("Connection error — check server URL and key");
        ws.onclose = () => !cancelled && setConnected(false);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  const send = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(text);
    // No manual echo here — this is now a real pty, which echoes typed
    // input back through the same output stream on its own, exactly
    // like a normal terminal.
  };

  const sendInput = () => {
    if (!input.trim() && input !== "") return;
    send(input + "\n");
    setInput("");
  };

  const sendKey = (bytes: string) => send(bytes);

  // Cheap, common-case detection only — see README Limitations for
  // what this deliberately does not attempt to handle.
  const showYesNo = /\((y\/n)\)|\[(y\/n|Y\/n|y\/N)\]/i.test(output.slice(-300));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <HeaderButton label="Back" onPress={onBack} />
        <Text style={styles.title}>Terminal</Text>
        <Text style={{ color: connected ? "#22c55e" : "#ef4444", fontSize: 12, fontWeight: "700" }}>
          {connected ? "connected" : "..."}
        </Text>
      </View>

      {error && <Text style={[styles.cardMeta, { paddingHorizontal: 16 }]}>{error}</Text>}

      <ScrollView ref={scrollRef} style={styles.logBox}>
        <Text style={styles.logLine}>{output || "Connecting..."}</Text>
      </ScrollView>

      {showYesNo && (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 8 }}>
          <Pressable
            style={[styles.lineIconButton, { backgroundColor: "#166534", flex: 1, alignItems: "center" }]}
            onPress={() => send("y\n")}
          >
            <Text style={styles.lineIconText}>Yes</Text>
          </Pressable>
          <Pressable
            style={[styles.lineIconButton, { backgroundColor: "#7f1d1d", flex: 1, alignItems: "center" }]}
            onPress={() => send("n\n")}
          >
            <Text style={styles.lineIconText}>No</Text>
          </Pressable>
        </View>
      )}

      <View style={{ marginBottom: keyboardHeight }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.keyToolbar}
          contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
        >
          <KeyButton label="Esc" onPress={() => sendKey("\x1b")} />
          <KeyButton label="Tab" onPress={() => sendKey("\t")} />
          <KeyButton label="↑" onPress={() => sendKey("\x1b[A")} />
          <KeyButton label="↓" onPress={() => sendKey("\x1b[B")} />
          <KeyButton label="←" onPress={() => sendKey("\x1b[D")} />
          <KeyButton label="→" onPress={() => sendKey("\x1b[C")} />
          <KeyButton label="Ctrl+C" onPress={() => sendKey("\x03")} danger />
          <KeyButton label="Ctrl+D" onPress={() => sendKey("\x04")} />
          <KeyButton label="Ctrl+L" onPress={() => sendKey("\x0c")} />
        </ScrollView>

        <View style={{ flexDirection: "row", gap: 8, padding: 16, paddingBottom: 28 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Type a command or response..."
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={sendInput}
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable style={styles.goButton} onPress={sendInput}>
            <Text style={styles.actionButtonText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function AddServiceCard({ onAdded }: { onAdded: () => void | Promise<void> }) {
  const [mode, setMode] = useState<"track" | "create">("track");
  const [busy, setBusy] = useState(false);

  // Track existing
  const [trackLabel, setTrackLabel] = useState("");
  const [trackUnit, setTrackUnit] = useState("");

  // Create new
  const [label, setLabel] = useState("");
  const [unit, setUnit] = useState("");
  const [description, setDescription] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [execStart, setExecStart] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [scheduleTimes, setScheduleTimes] = useState("");

  const doTrack = async () => {
    Keyboard.dismiss();
    const l = trackLabel.trim();
    const u = trackUnit.trim();
    if (!l || !u) {
      Alert.alert("Missing info", "Enter both a display name and the unit name.");
      return;
    }
    setBusy(true);
    try {
      await addService(l, u);
      setTrackLabel("");
      setTrackUnit("");
      await onAdded();
    } catch (e: any) {
      Alert.alert("Couldn't add service", e.message);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    Keyboard.dismiss();
    const l = label.trim();
    const u = unit.trim();
    const cmd = execStart.trim();
    if (!l || !u || !cmd) {
      Alert.alert("Missing info", "Name, unit, and the command to run are required.");
      return;
    }
    const times = scheduled
      ? scheduleTimes.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    if (scheduled && times.length === 0) {
      Alert.alert("Missing schedule", "Enter at least one time (e.g. 09:30, 15:00).");
      return;
    }
    setBusy(true);
    try {
      await createService({
        label: l,
        unit: u,
        description: description.trim(),
        workingDirectory: workingDirectory.trim(),
        execStart: cmd,
        scheduleTimes: times,
      });
      setLabel("");
      setUnit("");
      setDescription("");
      setWorkingDirectory("");
      setExecStart("");
      setScheduleTimes("");
      await onAdded();
    } catch (e: any) {
      Alert.alert("Couldn't create service", e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.addServiceCard}>
      <View style={styles.modeToggleRow}>
        <Pressable
          style={[styles.modeToggleButton, mode === "track" && styles.modeToggleButtonActive]}
          onPress={() => setMode("track")}
        >
          <Text style={[styles.modeToggleText, mode === "track" && styles.modeToggleTextActive]}>
            Track Existing
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeToggleButton, mode === "create" && styles.modeToggleButtonActive]}
          onPress={() => setMode("create")}
        >
          <Text style={[styles.modeToggleText, mode === "create" && styles.modeToggleTextActive]}>
            Create New
          </Text>
        </Pressable>
      </View>

      {mode === "track" ? (
        <>
          <Text style={[styles.cardMeta, { marginTop: 10 }]}>
            For a service you already set up on the server yourself.
          </Text>
          <TextInput
            value={trackLabel}
            onChangeText={setTrackLabel}
            placeholder="Display name, e.g. News Scraper"
            placeholderTextColor="#6b7280"
            style={[styles.input, { marginTop: 8 }]}
          />
          <TextInput
            value={trackUnit}
            onChangeText={setTrackUnit}
            placeholder="systemd unit name, e.g. news-bot"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            style={[styles.input, { marginTop: 8 }]}
          />
          <Pressable
            style={[styles.addButton, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={doTrack}
          >
            <Text style={styles.actionButtonText}>{busy ? "Adding..." : "Add Service"}</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.cardMeta, { marginTop: 10 }]}>
            Writes and starts a brand new systemd unit on the server —
            no server-side setup needed first.
          </Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Display name, e.g. News Scraper"
            placeholderTextColor="#6b7280"
            style={[styles.input, { marginTop: 8 }]}
          />
          <TextInput
            value={unit}
            onChangeText={setUnit}
            placeholder="Unit name, e.g. news-bot"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            style={[styles.input, { marginTop: 8 }]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Description (optional)"
            placeholderTextColor="#6b7280"
            style={[styles.input, { marginTop: 8 }]}
          />
          <TextInput
            value={workingDirectory}
            onChangeText={setWorkingDirectory}
            placeholder="Working directory (optional — defaults to current)"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            style={[styles.input, { marginTop: 8 }]}
          />
          <TextInput
            value={execStart}
            onChangeText={setExecStart}
            placeholder="Command to run, e.g. /usr/bin/python3 app.py"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            style={[styles.input, { marginTop: 8 }]}
          />

          <Pressable
            style={styles.scheduleToggleRow}
            onPress={() => setScheduled((v) => !v)}
          >
            <View style={[styles.checkbox, scheduled && styles.checkboxChecked]} />
            <Text style={styles.cardMeta}>
              Run on a schedule instead of continuously
            </Text>
          </Pressable>

          {scheduled && (
            <TextInput
              value={scheduleTimes}
              onChangeText={setScheduleTimes}
              placeholder="Times (24h), comma-separated: 09:30, 13:30, 15:00"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              style={[styles.input, { marginTop: 8 }]}
            />
          )}

          <Pressable
            style={[styles.addButton, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={doCreate}
          >
            <Text style={styles.actionButtonText}>{busy ? "Creating..." : "Create Service"}</Text>
          </Pressable>
        </>
      )}

      <Text style={[styles.cardMeta, { marginTop: 8 }]}>
        Long-press a service's name above to remove it.
      </Text>
    </View>
  );
}

function FilesScreen({ onBack }: { onBack: () => void }) {
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);

  // Registered while this screen is mounted — if a file is open in the
  // editor, back should close the editor first rather than immediately
  // leaving the whole Files screen. Falls through (returns false) to
  // the app-level handler otherwise.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (editingPath) {
        setEditingPath(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [editingPath]);

  const load = useCallback(async (target?: string) => {
    setLoading(true);
    try {
      if (target) {
        await cdTo(target);
      }
      const pwd = await getPwd();
      const res = await listFiles();
      setPath(pwd.path);
      setEntries(res.entries);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const goUp = () => {
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    load(parent);
  };

  const [opening, setOpening] = useState<string | null>(null);

  const openWith = async (name: string) => {
    const full = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
    setOpening(name);
    try {
      await openFileExternally(full);
    } catch (e: any) {
      Alert.alert("Couldn't open file", e.message);
    } finally {
      setOpening(null);
    }
  };

  if (editingPath) {
    return <EditorScreen path={editingPath} onBack={() => setEditingPath(null)} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <HeaderButton label="Back" onPress={onBack} />
        <Text style={styles.title}>Files</Text>
        <HeaderButton label="Up" onPress={goUp} />
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={styles.cardMeta} numberOfLines={2}>
          {path}
        </Text>
        <Text style={[styles.cardMeta, { marginTop: 4 }]}>
          Tap a file to open the built-in editor · long-press to try an external app instead
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 12 }}>
          <TextInput
            value={manualPath}
            onChangeText={setManualPath}
            placeholder="Jump to path, e.g. /opt/ec2-control"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable
            style={styles.goButton}
            onPress={() => {
              if (manualPath.trim()) {
                load(manualPath.trim());
                setManualPath("");
              }
            }}
          >
            <Text style={styles.actionButtonText}>Go</Text>
          </Pressable>
        </View>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={[styles.cardMeta, { paddingHorizontal: 16 }]}>{error}</Text>
      ) : (
        <ScrollView style={{ paddingHorizontal: 16 }}>
          {entries.map((entry) => (
            <Pressable
              key={entry.name}
              style={styles.fileRow}
              onPress={() => {
                const full = path.endsWith("/") ? `${path}${entry.name}` : `${path}/${entry.name}`;
                entry.is_dir ? load(full) : setEditingPath(full);
              }}
              onLongPress={() => !entry.is_dir && openWith(entry.name)}
            >
              <Text style={styles.fileIcon}>{entry.is_dir ? "[DIR]" : "[F]"}</Text>
              <Text style={styles.fileName} numberOfLines={1}>
                {entry.name}
              </Text>
              {opening === entry.name && <ActivityIndicator size="small" />}
              {!entry.is_dir && entry.size != null && opening !== entry.name && (
                <Text style={styles.cardMeta}>{entry.size}B</Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// Lists every saved server profile, marks which is active, lets you tap
// one to switch, long-press to edit/delete, or add a new one.
function ServersScreen({
  onBack,
  onSwitched,
  onAddNew,
  onEdit,
}: {
  onBack: () => void;
  onSwitched: () => void;
  onAddNew: () => void;
  onEdit: (server: ServerProfile) => void;
}) {
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const list = await listServers();
    const id = await getActiveServerId();
    setServers(list);
    setActiveId(id);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <HeaderButton label="Back" onPress={onBack} />
          <Text style={styles.title}>Servers</Text>
          <View style={{ width: 60 }} />
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 24 }} />
        ) : (
          servers.map((s) => {
            const isActive = s.id === activeId;
            return (
              <Pressable
                key={s.id}
                style={[styles.serverCard, isActive && styles.serverCardActive]}
                onPress={async () => {
                  await setActiveServerId(s.id);
                  onSwitched();
                }}
                onLongPress={() => onEdit(s)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.serviceLabel}>{s.name}</Text>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {s.baseUrl}
                  </Text>
                </View>
                {isActive && (
                  <View style={styles.activeBadge}>
                    <Text style={styles.activeBadgeText}>Active</Text>
                  </View>
                )}
              </Pressable>
            );
          })
        )}

        <Text style={[styles.cardMeta, { marginTop: 4, marginBottom: 16 }]}>
          Tap a server to switch to it. Long-press to edit or delete it.
        </Text>

        <Pressable style={styles.commandsButton} onPress={onAddNew}>
          <Text style={styles.commandsButtonText}>+ Add Server</Text>
        </Pressable>
      </ScrollView>	 
    </SafeAreaView>
  );
}

// Create or edit a single server profile (name, URL, API key).
function ServerFormScreen({
  initial,
  onCancel,
  onSaved,
}: {
  initial: ServerProfile | null;
  onCancel?: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    Keyboard.dismiss();
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "");
    const trimmedKey = apiKey.trim();
    if (!trimmedName || !trimmedUrl || !trimmedKey) {
      Alert.alert("Missing info", "Fill in a name, server URL, and API key.");
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await updateServer(initial.id, { name: trimmedName, baseUrl: trimmedUrl, apiKey: trimmedKey });
      } else {
        const profile = await addServer(trimmedName, trimmedUrl, trimmedKey);
        await setActiveServerId(profile.id);
      }
      onSaved();
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        {onCancel ? <HeaderButton label="Cancel" onPress={onCancel} /> : <View style={{ width: 60 }} />}
        <Text style={styles.title}>{initial ? "Edit Server" : "Add Server"}</Text>
        <View style={{ width: 60 }} />
      </View>
      <View style={{ padding: 16 }}>
        <Text style={styles.cardLabel}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Arbitrage Instance"
          placeholderTextColor="#6b7280"
          style={[styles.input, { marginTop: 8 }]}
        />
        <Text style={[styles.cardLabel, { marginTop: 12 }]}>Server URL</Text>
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://your-domain"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          style={[styles.input, { marginTop: 8 }]}
        />
        <Text style={[styles.cardLabel, { marginTop: 12 }]}>API Key</Text>
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="CONTROL_API_KEY value"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          secureTextEntry
          style={[styles.input, { marginTop: 8 }]}
        />
        <Pressable style={[styles.saveButton, saving && { opacity: 0.5 }]} disabled={saving} onPress={save}>
          <Text style={styles.actionButtonText}>{saving ? "Saving..." : "Save"}</Text>
        </Pressable>

        {initial && (
          <Pressable
            style={styles.deleteButton}
            onPress={() =>
              Alert.alert("Delete server", `Delete "${initial.name}"? This won't touch the server itself.`, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: async () => {
                    await deleteServer(initial.id);
                    onSaved();
                  },
                },
              ])
            }
          >
            <Text style={[styles.actionButtonText, { color: "#ef4444" }]}>Delete Server</Text>
          </Pressable>
        )}
      </View>	
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0f14" },
  scroll: { padding: 16, paddingBottom: 48 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    marginTop: 40,
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "600" },
  headerButton: {
    backgroundColor: "#1f2937",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    minWidth: 44,
    alignItems: "center",
  },
  headerButtonText: { color: "#60a5fa", fontSize: 15, fontWeight: "600" },
  activeServerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#12181f",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  activeServerText: { color: "#9ca3af", fontSize: 13 },
  activeServerSwitch: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },
  terminalEntryButton: {
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#374151",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 16,
  },
  terminalEntryText: { color: "#22c55e", fontWeight: "700", fontFamily: "monospace" },
  keyToolbar: {
    maxHeight: 52,
    borderTopWidth: 1,
    borderTopColor: "#1f2937",
    backgroundColor: "#0b0f14",
  },
  keyButton: {
    borderWidth: 1,
    borderColor: "#374151",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  keyButtonText: { color: "#e5e7eb", fontFamily: "monospace", fontSize: 13, fontWeight: "700" },
  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1 },
  cardDown: { backgroundColor: "#2a1414", borderColor: "#ef4444" },
  cardLabel: { color: "#9ca3af", fontSize: 13 },
  cardMeta: { color: "#9ca3af", fontSize: 13, marginTop: 6 },
  sectionTitle: { color: "#fff", fontSize: 17, fontWeight: "700", marginTop: 8, marginBottom: 12 },
  serviceCard: {
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    backgroundColor: "#12181f",
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  serviceLabel: { color: "#fff", fontSize: 17, fontWeight: "700", marginBottom: 8 },
  statusPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  statusOk: { backgroundColor: "#0f2419" },
  statusBad: { backgroundColor: "#2a1414" },
  statusPillText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  buttonGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14, marginBottom: 10 },
  gridButton: {
    flexBasis: "47%",
    flexGrow: 1,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  actionButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#374151",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: { color: "#e5e7eb" },
  addServiceCard: {
    borderRadius: 16,
    padding: 16,
    marginTop: 4,
    marginBottom: 24,
    backgroundColor: "#12181f",
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  scopeBadge: { color: "#6b7280", fontSize: 12, fontWeight: "400" },
  modeToggleRow: { flexDirection: "row", gap: 8 },
  modeToggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#374151",
  },
  modeToggleButtonActive: { backgroundColor: "#1e3a8a", borderColor: "#3b82f6" },
  modeToggleText: { color: "#9ca3af", fontSize: 13, fontWeight: "600" },
  modeToggleTextActive: { color: "#fff" },
  scheduleToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#6b7280",
  },
  checkboxChecked: { backgroundColor: "#3b82f6", borderColor: "#3b82f6" },
  scriptCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    backgroundColor: "#12181f",
    borderWidth: 1,
    borderColor: "#1f2937",
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
  },
  scriptCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  runChip: {
    backgroundColor: "#f59e0b",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  runChipText: { color: "#0b0f14", fontWeight: "700", fontSize: 13 },
  commandsButton: {
    marginTop: 8,
    backgroundColor: "#1f2937",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
  },
  commandsButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  commandLineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  commandLineBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#1f2937",
    alignItems: "center",
    justifyContent: "center",
  },
  commandLineBadgeText: { color: "#9ca3af", fontSize: 12, fontWeight: "700" },
  commandLineInput: {
    flex: 1,
    backgroundColor: "#111827",
    color: "#fff",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#374151",
    fontFamily: "monospace",
    fontSize: 13,
  },
  lineIconButton: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  lineIconText: { color: "#60a5fa", fontSize: 12, fontWeight: "700" },
  addLineButton: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: "#374151",
    borderStyle: "dashed",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  resultBox: { backgroundColor: "#0b0f14", borderRadius: 10, padding: 10, marginTop: 6 },
  resultCommand: { color: "#fff", fontFamily: "monospace", fontSize: 12, marginBottom: 4 },
  logBox: { flex: 1, paddingHorizontal: 16 },
  editorInput: {
    minHeight: "100%",
    backgroundColor: "#1e1e1e",
    color: "#d4d4d4",
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
    padding: 16,
    textAlignVertical: "top",
  },
  codeLineRow: { flexDirection: "row", paddingHorizontal: 12 },
  codeLineNumber: {
    color: "#5a5a5a",
    fontFamily: "monospace",
    fontSize: 12,
    width: 36,
    textAlign: "right",
    marginRight: 12,
  },
  codeLineText: { fontFamily: "monospace", fontSize: 13, color: "#d4d4d4" },
  codeListContent: { backgroundColor: "#1e1e1e", paddingVertical: 8 },
  findToggle: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  findToggleText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },
  findBar: {
    backgroundColor: "#12181f",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#1f2937",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  logLine: { color: "#a1a1aa", fontFamily: "monospace", fontSize: 12, marginBottom: 2 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2937",
  },
  fileIcon: { color: "#60a5fa", fontSize: 12, fontFamily: "monospace", width: 40 },
  fileName: { color: "#e5e7eb", flex: 1, fontSize: 14 },
  goButton: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  serverCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    backgroundColor: "#12181f",
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  serverCardActive: { borderColor: "#22c55e" },
  activeBadge: {
    backgroundColor: "#0f2419",
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  activeBadgeText: { color: "#22c55e", fontSize: 12, fontWeight: "700" },
  input: {
    backgroundColor: "#111827",
    color: "#fff",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#374151",
    fontSize: 15,
  },
  addButton: {
    marginTop: 10,
    backgroundColor: "#3b82f6",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  saveButton: {
    marginTop: 20,
    backgroundColor: "#3b82f6",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  deleteButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#ef4444",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.65)", // Dark semi-transparent background
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    backgroundColor: "#12181f", // Matches your app's card backgrounds
    borderRadius: 16,
    padding: 32, // Proper padding from all directions
    width: "100%",
    maxWidth: 320,
    borderWidth: 1,
    borderColor: "#1f2937",
    // Subtle shadow for aesthetics
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  modalTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 32,
  },
  modalButtonGroup: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16, // Space between buttons
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 12,
    backgroundColor: "#0b0f14", // Slightly darker button background
    borderWidth: 1,
    borderColor: "#374151", // Light aesthetic border
  },
  modalButtonPrimary: {
    backgroundColor: "#1f2937", // Slightly lighter for the "No" button to emphasize it
  },
  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});