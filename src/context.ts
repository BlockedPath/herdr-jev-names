/**
 * Collects what a pane is doing: agent, title, command, project, branch and prompts.
 * Terminal output is read separately, only when Jev will be asked.
 */
import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ForegroundProcess, Herdr, SnapshotPane } from "./herdr";
import { run } from "./herdr";
import { basename, redact, sameText, tidy } from "./text";

export interface GitInfo {
  root: string;
  branch: string | null;
}

export interface PaneContext {
  paneId: string;
  tabId: string;
  workspaceId: string;
  label: string | null;
  agent: string | null;
  agentStatus: string;
  /** Task phrases from the terminal title, with agent names, paths and spinners removed. */
  titlePhrases: string[];
  rawTitle: string | null;
  /** Foreground command when it is not the pane's shell. */
  command: string[] | null;
  cwd: string | null;
  project: string | null;
  /** Path inside the repository, e.g. `packages/web`. */
  subdir: string | null;
  branch: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  /** Requests before the latest one, newest first. */
  earlierPrompts: string[];
  /** The agent's latest reply, for panes whose requests name no topic ("try again"). */
  lastReply: string | null;
  /** The agent's transcript, when herdr reports one. */
  sessionFile: string | null;
  output: string;
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "-sh", "nu", "dash", "ksh", "tcsh", "csh", "xonsh", "elvish", "pwsh", "login"]);

export const AGENT_WORDS = new Set([
  "amp", "claude", "claude code", "codex", "pi", "grok", "gemini", "cursor", "cursor agent", "cursor-agent",
  "opencode", "open_code", "aider", "goose", "droid", "copilot", "qwen", "kimi", "crush", "agent",
]);

const BRANCH_DEFAULTS = new Set(["main", "master", "trunk", "develop", "dev", "HEAD"]);

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

function isPathLike(segment: string): boolean {
  return /^(~|\/|\.\.?\/)/.test(segment) || (/\//.test(segment) && !/\s/.test(segment));
}

/**
 * Splits a terminal title into task phrases. Agents write titles such as
 * "Meta hooks race - amp - ~/dev/pi-meta-oauth" or "π - bounty"; only "Meta hooks race" is useful.
 */
export function titlePhrases(
  title: string | null | undefined,
  drop: { agent?: string | null; displayAgent?: string | null; project?: string | null; cwd?: string | null },
): string[] {
  if (!title) return [];
  const segments = title.split(/\s+[-–—|:·•]\s+|\s{2,}/);
  const out: string[] = [];
  for (const raw of segments) {
    const s = tidy(raw)
      .replace(/\s*\((?:~|\/)[^)]*\)/g, "") // "main.rs (~/dev/x/src)"
      .replace(/\s+(?:~|\/)\S*$/, "") // fish: "npm run dev ~/d/webapp"
      .replace(/^[^\p{L}\p{N}~/.]+|[^\p{L}\p{N})\]]+$/gu, "");
    if (Array.from(s).length < 3) continue;
    const lower = s.toLowerCase();
    if (AGENT_WORDS.has(lower) || SHELLS.has(lower)) continue;
    if (sameText(s, drop.agent) || sameText(s, drop.displayAgent) || sameText(s, drop.project)) continue;
    if (drop.cwd && (sameText(s, basename(drop.cwd)) || sameText(s, displayPath(drop.cwd)))) continue;
    if (isPathLike(s)) continue;
    if (/^[\w.-]+@[\w.-]+(:.*)?$/.test(s)) continue; // user@host
    if (!/\p{L}/u.test(s)) continue;
    if (!out.some((o) => sameText(o, s))) out.push(s);
  }
  return out;
}

/** The foreground command if something other than the shell is running. */
export function foregroundCommand(processes: ForegroundProcess[] | undefined): string[] | null {
  if (!processes?.length) return null;
  for (const p of processes) {
    const argv = p.argv?.length ? p.argv : p.cmdline ? p.cmdline.split(/\s+/) : p.argv0 ? [p.argv0] : p.name ? [p.name] : [];
    if (!argv.length) continue;
    const head = basename(argv[0]!);
    if (SHELLS.has(head) || SHELLS.has(p.name ?? "")) continue;
    // `node /path/to/cli.js args` reads better as the script name.
    if (/^(node|bun|deno|python[\d.]*|ruby|perl)$/.test(head) && p.argv0 && !SHELLS.has(p.argv0) && basename(p.argv0) !== head) {
      return redactArgv([basename(p.argv0), ...argv.slice(2)]);
    }
    return redactArgv([head, ...argv.slice(1)]);
  }
  return null;
}

/** True if a title only repeats the command line, e.g. "npm run dev" or "NVIM" for nvim. */
export function echoesCommand(title: string, command: string[]): boolean {
  const words = title.toLowerCase().split(/\s+/).filter(Boolean);
  const program = basename(command[0]!).toLowerCase();
  const line = command.join(" ").toLowerCase();
  return words[0] === program || words.every((w) => line.includes(w));
}

const SECRET_FLAG = /^--?(?:password|passwd|pass|pwd|token|secret|api-?key|apikey|auth|auth-token|access-token|client-secret|key-password)$/i;

/**
 * Redacts secrets in a command line: values after credential flags (`--token X`, `sshpass -p X`,
 * `redis-cli -a X`, `curl -u user:pass`), mysql's `-pX`, and anything redact() catches.
 */
export function redactArgv(argv: string[]): string[] {
  const program = basename(argv[0] ?? "");
  const out = argv.map((a) => redact(a));
  for (let i = 1; i < out.length; i++) {
    const a = argv[i]!;
    const valueFlag =
      SECRET_FLAG.test(a) ||
      (program === "sshpass" && a === "-p") ||
      (/^redis-cli$/.test(program) && a === "-a") ||
      (/^(curl|wget|http|xh)$/.test(program) && (a === "-u" || a === "--user"));
    if (valueFlag && i + 1 < out.length) {
      out[i + 1] = /^(curl|wget|http|xh)$/.test(program) ? argv[i + 1]!.replace(/:.*/, ":[redacted]") : "[redacted]";
      i++;
    } else if (/^(mysql|mariadb|mysqldump|mysqladmin)$/.test(program) && /^-p.+/.test(a)) {
      out[i] = "-p[redacted]";
    }
  }
  // Rules that need neighbouring words (`password: x`) run on the joined line too.
  const joined = out.join(" ");
  return redact(joined) === joined ? out : redact(joined).split(" ");
}

const gitCache = new Map<string, Promise<GitInfo | null>>();

export function gitInfo(cwd: string): Promise<GitInfo | null> {
  let cached = gitCache.get(cwd);
  if (!cached) {
    cached = (async () => {
      if (!existsSync(cwd)) return null;
      const res = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], 2000).catch(() => null);
      if (!res || res.code !== 0) return null;
      const [root, branch] = res.stdout.trim().split("\n");
      if (!root) return null;
      return { root, branch: branch && branch !== "HEAD" ? branch : null };
    })();
    gitCache.set(cwd, cached);
  }
  return cached;
}

/** A branch name worth showing: strips `feat/` style prefixes and ignores default branches. */
export function branchTopic(branch: string | null): string | null {
  if (!branch || BRANCH_DEFAULTS.has(branch)) return null;
  const tail = branch.split("/").pop() ?? branch;
  const topic = tail
    .replace(/^(?:[A-Z]+-\d+[-_])/, "") // ticket id: ENG-123-
    .replace(/[-_]+/g, " ")
    .replace(/^(?:fix|feat|feature|add|update|refactor|chore|implement|remove|bump)\s+/i, "")
    .replace(/\s+(?=\S*\d)(?=\S*[A-Za-z])[A-Za-z0-9]{4,}$/, "") // tool-generated suffix: -Xb12z
    .trim();
  return topic.length >= 3 ? topic : null;
}

// ---------------------------------------------------------------------------------------------
// Agent session files: the user's first and latest request.

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;

function readSlice(path: string, from: "head" | "tail", bytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const position = from === "head" ? 0 : size - length;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, position);
    let text = buf.toString("utf8");
    // Drop the partial line at a cut edge.
    if (from === "tail" && position > 0) text = text.slice(text.indexOf("\n") + 1);
    if (from === "head" && length < size) text = text.slice(0, text.lastIndexOf("\n"));
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result" || b.type === "function_call_output") return null;
    if ((b.type === "text" || b.type === "input_text") && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/** A user-typed request from one JSONL line of a pi, Claude Code or Codex session. */
export function userRequest(line: string): string | null {
  if (!line.includes("user")) return null;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  let text: string | null = null;
  if (entry?.type === "message" && entry.message?.role === "user") text = textOf(entry.message.content); // pi
  else if (entry?.type === "user" && entry.message?.role === "user" && !entry.isMeta) text = textOf(entry.message.content); // Claude Code
  else if (entry?.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") text = textOf(entry.payload.content); // Codex
  if (!text) return null;
  const trimmed = text.trim();
  // Harness-injected context, slash-command wrappers and caveats are not the user's request.
  if (!trimmed || /^<[\w-]+[\s>]/.test(trimmed) || trimmed.startsWith("# AGENTS.md") || trimmed.startsWith("Caveat:")) return null;
  // Interrupt markers and bare slash commands ("/clear", "/model opus") say nothing about the task.
  if (/^\[Request interrupted/i.test(trimmed) || /^\/[\w:-]+(\s+\S+){0,2}$/.test(trimmed)) return null;
  return trimmed;
}

/** The text of an assistant reply from one JSONL line of a pi, Claude Code or Codex session. */
export function assistantReply(line: string): string | null {
  if (!line.includes("assistant")) return null;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  let content: unknown = null;
  if (entry?.type === "message" && entry.message?.role === "assistant") content = entry.message.content; // pi
  else if (entry?.type === "assistant" && entry.message?.role === "assistant") content = entry.message.content; // Claude Code
  else if (entry?.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "assistant") content = entry.payload.content; // Codex
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b && typeof b === "object" && (b.type === "text" || b.type === "output_text") && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

export interface SessionText {
  first: string | null;
  last: string | null;
  /** Requests before the latest one, newest first (up to two). */
  earlier: string[];
  /** The agent's latest reply. */
  reply: string | null;
}

export function sessionPrompts(path: string): SessionText {
  const head = readSlice(path, "head", HEAD_BYTES).split("\n");
  let first: string | null = null;
  for (const line of head) {
    first = userRequest(line);
    if (first) break;
  }
  const tail = readSlice(path, "tail", TAIL_BYTES).split("\n");
  const requests: string[] = [];
  let reply: string | null = null;
  for (let i = tail.length - 1; i >= 0 && requests.length < 3; i--) {
    const request = userRequest(tail[i]!);
    if (request) requests.push(request);
    else if (!reply && !requests.length) reply = assistantReply(tail[i]!);
  }
  return { first, last: requests[0] ?? first, earlier: requests.slice(1), reply };
}

/** Locates the transcript for a session herdr reported by id (Claude Code, Codex) or path (pi). */
export function sessionPath(session: AgentSession | null | undefined, cwd: string | null): string | null {
  if (!session?.value) return null;
  if (session.kind === "path") return existsSync(session.value) ? session.value : null;
  const id = session.value.replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return null;
  const home = homedir();
  if (/claude/i.test(session.agent) && cwd) {
    const p = join(home, ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  if (/codex/i.test(session.agent)) {
    // Rollouts live in sessions/YYYY/MM/DD; look back a week.
    const root = join(home, ".codex/sessions");
    for (let back = 0; back < 7; back++) {
      const d = new Date(Date.now() - back * 86_400_000);
      const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      try {
        const hit = readdirSync(dir).find((f) => f.endsWith(`${id}.jsonl`));
        if (hit) return join(dir, hit);
      } catch {
        // missing day directory
      }
    }
  }
  return null;
}

function clip(text: string | null, max: number): string | null {
  if (!text) return null;
  const t = redact(text.replace(/\s+/g, " ").trim());
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export interface CollectOptions {
  sendPrompts: boolean;
}

export async function collectPane(herdr: Herdr, pane: SnapshotPane, agentInfo: SnapshotPane | undefined, opts: CollectOptions): Promise<PaneContext> {
  const info = { ...pane, ...agentInfo };
  const cwd = info.foreground_cwd || info.cwd || null;
  const [proc, git] = await Promise.all([herdr.processInfo(pane.pane_id), cwd ? gitInfo(cwd) : Promise.resolve(null)]);
  const project = git ? basename(git.root) : cwd ? basename(cwd) : null;
  let subdir: string | null = null;
  if (git && cwd && cwd.startsWith(git.root + "/")) subdir = cwd.slice(git.root.length + 1);

  const sessionFile = info.agent ? sessionPath(info.agent_session, cwd) : null;
  const session = opts.sendPrompts && sessionFile ? readSession(sessionFile) : EMPTY_SESSION;

  const command = info.agent ? null : foregroundCommand(proc?.foreground_processes);
  let title = info.terminal_title_stripped ?? info.terminal_title ?? null;
  // A title that repeats the command line may carry its secrets; send the redacted command instead.
  if (title && command && echoesCommand(tidy(title), command)) title = command.join(" ");
  return {
    ...sessionFields(session),
    sessionFile,
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    label: pane.label ?? null,
    agent: info.agent ?? null,
    agentStatus: info.agent_status ?? "unknown",
    titlePhrases: titlePhrases(title, { agent: info.agent, displayAgent: info.display_agent, project, cwd }).map(redact),
    rawTitle: title ? redact(tidy(title)) : null,
    command,
    cwd,
    project,
    subdir,
    branch: git?.branch ?? null,
    output: "",
  };
}

const EMPTY_SESSION: SessionText = { first: null, last: null, earlier: [], reply: null };

/** A transcript's requests and latest reply, or nothing if it can't be read. */
export function readSession(path: string): SessionText {
  try {
    return statSync(path).isFile() ? sessionPrompts(path) : EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

/** Transcript text as sent to Jev: clipped and redacted. */
export function sessionFields(session: SessionText): Pick<PaneContext, "firstPrompt" | "lastPrompt" | "earlierPrompts" | "lastReply"> {
  return {
    firstPrompt: clip(session.first, 1200),
    lastPrompt: clip(session.last, 1200),
    earlierPrompts: session.earlier.map((p) => clip(p, 400)!),
    lastReply: clip(session.reply, 800),
  };
}
