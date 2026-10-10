/** Thin wrapper over the `herdr` CLI. Every call is a subprocess; JSON replies are parsed. */

export interface AgentSession {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
}

export interface SnapshotPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  agent?: string | null;
  agent_status?: string;
  display_agent?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  agent_session?: AgentSession | null;
  tokens?: Record<string, string>;
}

export interface SnapshotTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  pane_count: number;
}

export interface SnapshotWorkspace {
  workspace_id: string;
  label: string;
  number: number;
}

export interface Snapshot {
  panes: SnapshotPane[];
  agents: SnapshotPane[];
  tabs: SnapshotTab[];
  workspaces: SnapshotWorkspace[];
  focused_pane_id?: string | null;
  focused_tab_id?: string | null;
}

export interface ForegroundProcess {
  argv?: string[];
  argv0?: string;
  cmdline?: string;
  cwd?: string;
  name?: string;
  pid?: number;
}

export interface ProcessInfo {
  foreground_processes: ForegroundProcess[];
  shell_pid?: number;
  foreground_process_group_id?: number;
}

/** The herdr operations the plugin uses. Tests substitute a fake. */
export interface Herdr {
  snapshot(): Promise<Snapshot>;
  processInfo(paneId: string): Promise<ProcessInfo | null>;
  read(paneId: string, lines: number): Promise<string>;
  renamePane(paneId: string, label: string): Promise<void>;
  clearPaneLabel(paneId: string): Promise<void>;
  renameTab(tabId: string, label: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

export class HerdrError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(`herdr ${args.slice(0, 2).join(" ")} failed (${code}): ${detail.slice(0, 300)}`);
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command with a timeout. Never throws for a non-zero exit. */
export async function run(argv: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class HerdrCli implements Herdr {
  constructor(readonly bin: string = process.env.HERDR_BIN_PATH || "herdr") {}

  private async text(args: string[], timeoutMs = 5000): Promise<string> {
    const res = await run([this.bin, ...args], timeoutMs);
    if (res.code !== 0) throw new HerdrError(args, res.code, (res.stderr || res.stdout).trim());
    return res.stdout;
  }

  private async json(args: string[], timeoutMs = 5000): Promise<any> {
    const out = await this.text(args, timeoutMs);
    return out.trim() ? JSON.parse(out) : null;
  }

  async snapshot(): Promise<Snapshot> {
    const reply = await this.json(["api", "snapshot"], 8000);
    const snap = reply?.result?.snapshot;
    if (!snap) throw new Error("herdr api snapshot returned no snapshot");
    return {
      panes: snap.panes ?? [],
      agents: snap.agents ?? [],
      tabs: snap.tabs ?? [],
      workspaces: snap.workspaces ?? [],
      focused_pane_id: snap.focused_pane_id,
      focused_tab_id: snap.focused_tab_id,
    };
  }

  async processInfo(paneId: string): Promise<ProcessInfo | null> {
    try {
      const reply = await this.json(["pane", "process-info", "--pane", paneId]);
      return reply?.result?.process_info ?? null;
    } catch {
      return null;
    }
  }

  async read(paneId: string, lines: number): Promise<string> {
    try {
      return await this.text(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
    } catch {
      return "";
    }
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await this.text(["pane", "rename", paneId, label]);
  }

  async clearPaneLabel(paneId: string): Promise<void> {
    await this.text(["pane", "rename", paneId, "--clear"]);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.text(["tab", "rename", tabId, label]);
  }

  async notify(title: string, body: string): Promise<void> {
    await run([this.bin, "notification", "show", title, "--body", body], 3000).catch(() => undefined);
  }
}
