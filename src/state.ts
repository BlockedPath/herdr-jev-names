/**
 * Durable plugin state. Every hook is a fresh process, so names the plugin wrote, locks and
 * fingerprints live in a JSON file. One process works at a time; others leave a pending marker.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LastAgent } from "./lastagent";
import { digest } from "./text";

export interface PaneEntry {
  /** The label this plugin last applied. */
  auto?: string | null;
  /** A label this plugin is about to apply; saved first so a crash mid-rename can't orphan it. */
  pending?: string | null;
  /** Someone else named the pane; leave it alone until the user asks again. */
  locked?: boolean;
  /** Fingerprint of the context behind the last decision. */
  fp?: string;
  what?: string | null;
  /** The subject when it is part of the name; tabs use it. */
  subject?: string | null;
  /** The subject Jev last chose, used or not; keeps names from flickering. */
  subjectPick?: string | null;
  project?: string | null;
  branch?: string | null;
  title?: string | null;
  agent?: string | null;
  /** The agent that last ran in the pane, for naming the shell it leaves behind. */
  lastAgent?: LastAgent | null;
  /** The foreground command and when the plugin first saw it, to tell quick commands from long ones. */
  command?: { key: string; since: number } | null;
  /** The agent session the current name came from (`agent:transcript`); null for terminal names. */
  namedBy?: string | null;
  /** The remembered last-agent session already tried for this idle shell. */
  lastAgentTried?: string | null;
  at?: number;
}

export interface TabEntry {
  auto?: string | null;
  pending?: string | null;
  /** Jev's untruncated pick behind `auto`. */
  pick?: string | null;
  locked?: boolean;
  fp?: string;
  at?: number;
}

export interface State {
  version: 1;
  panes: Record<string, PaneEntry>;
  tabs: Record<string, TabEntry>;
  warnedAt?: number;
}

export type Ownership = "free" | "ours" | "foreign";

export type QueueItem =
  | { type: "event"; event: string; data?: Record<string, unknown> }
  | { type: "name-all" }
  | { type: "name-here"; paneId: string | null; tabId: string | null };

/**
 * Whether the plugin may set this label. A label the plugin did not write is someone else's,
 * except an empty one or a known placeholder. Clearing a label the plugin wrote also counts as
 * the user's choice.
 */
export function ownership(
  label: string | null | undefined,
  entry: { auto?: string | null; pending?: string | null; locked?: boolean } | undefined,
  isDefault: (label: string) => boolean,
): Ownership {
  if (entry?.locked) return "foreign";
  const current = (label ?? "").trim();
  if (current && (current === entry?.auto || current === entry?.pending)) return "ours";
  if (!current) return entry?.auto ? "foreign" : "free";
  if (isDefault(current)) return "free";
  return "foreign";
}

export class Store {
  readonly dir: string;
  readonly file: string;
  readonly lockDir: string;
  readonly pendingFile: string;
  readonly logFile: string;

  /** `scope` separates herdr servers (sessions) that share the plugin state dir. */
  constructor(stateDir: string, scope: string) {
    this.dir = stateDir;
    const ns = digest(scope).slice(0, 8);
    this.file = join(stateDir, `state-${ns}.json`);
    this.lockDir = join(stateDir, `lock-${ns}`);
    this.pendingFile = join(stateDir, `pending-${ns}`);
    this.logFile = join(stateDir, "decisions.jsonl");
    mkdirSync(stateDir, { recursive: true });
  }

  load(): State {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed?.version === 1) return { panes: {}, tabs: {}, ...parsed };
    } catch {
      // missing or corrupt: start over
    }
    return { version: 1, panes: {}, tabs: {} };
  }

  /**
   * Writes the state. Skipped when this process took the lock but has since lost it, so a run
   * that was declared stale cannot overwrite a newer run's state.
   */
  save(state: State): boolean {
    if (this.token && !this.ownsLock()) return false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, this.file);
    return true;
  }

  private token: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * Takes the lock, breaking it if the holder died or stopped refreshing it. Returns false if busy.
   * The holder refreshes the lock every 10 s, so a lock older than `staleMs` belongs to a hung or
   * vanished process even if its pid has been reused.
   */
  tryLock(staleMs = 90_000): boolean {
    const token = `${process.pid} ${crypto.randomUUID()}`;
    try {
      mkdirSync(this.lockDir);
    } catch {
      if (!this.lockIsStale(staleMs)) return false;
      // Rename first so two processes breaking the same lock cannot remove each other's new lock.
      const grave = `${this.lockDir}.stale-${token.replace(/\W/g, "")}`;
      try {
        renameSync(this.lockDir, grave);
      } catch {
        return false;
      }
      rmSync(grave, { recursive: true, force: true });
      try {
        mkdirSync(this.lockDir);
      } catch {
        return false;
      }
    }
    writeFileSync(join(this.lockDir, "owner"), token);
    this.token = token;
    this.heartbeat = setInterval(() => this.touchLock(), 10_000);
    this.heartbeat.unref?.();
    return true;
  }

  private lockIsStale(staleMs: number): boolean {
    try {
      const age = Date.now() - statSync(this.lockDir).mtimeMs;
      if (age > staleMs) return true;
      let owner = "";
      try {
        owner = readFileSync(join(this.lockDir, "owner"), "utf8");
      } catch {
        // the holder has not written its owner file yet
        return age > 5_000;
      }
      const pid = Number(owner.split(" ")[0]);
      try {
        if (pid > 0) process.kill(pid, 0);
        return false;
      } catch {
        return age > 1_000;
      }
    } catch {
      return false; // the lock vanished; the next tryLock will take it
    }
  }

  /** True while this process still holds the lock it took. */
  ownsLock(): boolean {
    if (!this.token) return false;
    try {
      return readFileSync(join(this.lockDir, "owner"), "utf8") === this.token;
    } catch {
      return false;
    }
  }

  private touchLock(): void {
    if (!this.ownsLock()) return;
    const now = new Date();
    try {
      utimesSync(this.lockDir, now, now);
    } catch {
      // ignore
    }
  }

  /** Releases the lock if this process still holds it; never removes someone else's. */
  unlock(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.ownsLock()) rmSync(this.lockDir, { recursive: true, force: true });
    this.token = null;
  }

  /** Queues work for whichever process holds the lock. Call before trying the lock. */
  enqueue(item: QueueItem): void {
    appendFileSync(this.pendingFile, JSON.stringify(item) + "\n");
  }

  hasPending(): boolean {
    return existsSync(this.pendingFile);
  }

  /** Takes every queued item. Only the lock holder calls this. */
  drain(): QueueItem[] {
    if (!existsSync(this.pendingFile)) return [];
    const taken = `${this.pendingFile}.${process.pid}`;
    try {
      renameSync(this.pendingFile, taken);
    } catch {
      return [];
    }
    let text = "";
    try {
      text = readFileSync(taken, "utf8");
    } finally {
      rmSync(taken, { force: true });
    }
    const items: QueueItem[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // torn write; the next event will trigger another sweep anyway
      }
    }
    return items;
  }

  /** Records that a sweep finished, for throttling frequent events. */
  markSwept(): void {
    writeFileSync(join(this.dir, `swept-${digest(this.file).slice(0, 8)}`), "");
  }

  sweptWithin(ms: number): boolean {
    try {
      return Date.now() - statSync(join(this.dir, `swept-${digest(this.file).slice(0, 8)}`)).mtimeMs < ms;
    } catch {
      return false;
    }
  }

  log(entry: Record<string, unknown>): void {
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > 512 * 1024) renameSync(this.logFile, `${this.logFile}.1`);
      appendFileSync(this.logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      // logging must never break naming
    }
  }
}
