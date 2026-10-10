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
  /** Files the agent recently edited or read, most relevant first. */
  files: TouchedFile[];
  /** True when the agent's requests could be read, so their absence means nobody asked yet. */
  promptsRead: boolean;
  /** Process group of the foreground job: a script and its children share it. */
  commandGroup: number | null;
  output: string;
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "-sh", "nu", "dash", "ksh", "tcsh", "csh", "xonsh", "elvish", "pwsh", "login"]);

export const AGENT_WORDS = new Set([
  "amp", "claude", "claude code", "codex", "pi", "grok", "gemini", "cursor", "cursor agent", "cursor-agent",
  "opencode", "open_code", "aider", "goose", "droid", "copilot", "qwen", "kimi", "crush", "agent",
  "devin", "agy", "cline", "omp", "mastracode", "kiro", "hermes", "kilo", "qodercli", "letta", "maki", "muse",
]);

/** Programs herdr recognizes as agents (`herdr agent start --kind`), by executable name. */
export const HERDR_AGENTS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "cursor-agent", "agent", "devin", "agy", "cline", "omp", "mastracode", "opencode",
  "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse",
]);

const PACKAGE_RUNNERS: Record<string, string | null> = { npx: null, bunx: null, pnpx: null, uvx: null, bun: "x", pnpm: "dlx", yarn: "dlx", pipx: "run" };

/** Normalizes a program or package name: `@openai/codex@latest` -> `codex`, `claude-code` -> `claude`. */
function agentWord(name: string): string | null {
  const bare = basename(name).toLowerCase().replace(/^@[^/]+\//, "").replace(/@.*$/, "");
  if (AGENT_WORDS.has(bare)) return bare;
  const stem = bare.replace(/-(?:code|cli|agent)$/, "");
  return AGENT_WORDS.has(stem) ? stem : null;
}

/** The coding agent a command runs, directly or through npx/bunx/pnpm dlx/uvx, or null. */
export function agentProgram(command: string[] | null): string | null {
  if (!command?.length) return null;
  const head = basename(command[0]!).toLowerCase();
  if (head in PACKAGE_RUNNERS) {
    const sub = PACKAGE_RUNNERS[head];
    let rest = command.slice(1);
    if (sub) {
      if (rest[0] !== sub) return agentWord(head);
      rest = rest.slice(1);
    }
    const pkg = rest.find((a) => !a.startsWith("-"));
    return pkg ? agentWord(pkg) : null;
  }
  return agentWord(head);
}

const BRANCH_DEFAULTS = new Set(["main", "master", "trunk", "develop", "dev", "HEAD"]);

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

function isPathLike(segment: string): boolean {
  return /^(~|\/|\.\.?\/)/.test(segment) || (/\//.test(segment) && !/\s/.test(segment));
}

/** Titles agents show while busy rather than naming the task. */
const STATUS_TITLE = /^(?:waiting(?: for (?:a |the )?(?:response|input|reply))?|thinking|working|generating|loading|processing|running|starting|ready|idle|compacting|retrying)\b/i;

/**
 * The conversation on an agent's screen as plain prose, for agents without a transcript (muse).
 * Prompt and reply markers are stripped, chrome such as status bars and key hints is dropped, and
 * wrapped lines are joined.
 */
export function agentScreen(output: string): string {
  let text = "";
  for (const raw of output.split("\n")) {
    if (/voice input|ctrl\+|⌥|⌘|esc to|shift\+tab|tokens?\b|context window|\bctx\b|% used|warning ·|hidden \(/i.test(raw)) continue;
    const line = raw.replace(/^\s*[❯›>◆●⏺•┃│▌✻✳*-]+\s*/u, "").trim();
    if (!line) continue;
    // Tool calls and their metadata ("Read 2 files · ctrl+o", "e · user · 3 KB"), cut-off status
    // lines and model or version names are not the conversation.
    if (/ · /.test(line) || /…$/.test(line) || /^[\w.-]*\d[\w.-]*$/.test(line)) continue;
    if (/^(?:Read|Edit(?:ed)?|Wrote|Write|Bash|Ran|Search(?:ed)?|Grep|Glob|Fetch(?:ed)?|List(?:ed)?|Update[d]?|Create[d]?|Called|Used)\b/.test(line) && line.length < 48) continue;
    // Narrow panes hard-wrap mid-word: "CLAUDE" / ".md".
    text += /^[.,;:!?)\]]/.test(line) ? line : (text ? " " : "") + line;
  }
  text = text.replace(/\s+/g, " ");
  if (text.length > 2500) text = text.slice(text.indexOf(" ", text.length - 2500) + 1);
  return text;
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
    if (STATUS_TITLE.test(s)) continue; // "Waiting for response", "Thinking…"
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

export interface TouchedFile {
  path: string;
  edited: boolean;
}

export interface SessionText {
  first: string | null;
  last: string | null;
  /** Requests before the latest one, newest first (up to two). */
  earlier: string[];
  /** The agent's latest reply. */
  reply: string | null;
  /** Files the agent recently edited or read, most relevant first. */
  files: TouchedFile[];
}

const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace_editor|create_file|apply_patch)$/i;
const READ_TOOLS = /^(read|view|open_file|notebookread)$/i;
const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/g;

/** File paths an agent's tool calls in one JSONL line touched (pi, Claude Code, Codex). */
export function toolFiles(line: string): TouchedFile[] {
  if (!/toolCall|tool_use|File: /.test(line)) return [];
  const out: TouchedFile[] = [];
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return out;
  }
  // Codex apply_patch, only inside a tool call: a diff pasted into a prompt or echoed in a reply
  // is not an edit.
  const payload = entry?.type === "response_item" ? entry.payload : null;
  if (payload && (payload.type === "custom_tool_call" || payload.type === "function_call")) {
    const input = typeof payload.input === "string" ? payload.input : typeof payload.arguments === "string" ? payload.arguments : "";
    for (const m of input.replace(/\\n/g, "\n").matchAll(PATCH_FILE)) out.push({ path: m[1]!.trim(), edited: true });
    return out;
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || (block.type !== "toolCall" && block.type !== "tool_use")) continue;
    const args = block.arguments ?? block.input ?? {};
    const path = args.path ?? args.file_path ?? args.notebook_path;
    if (typeof path !== "string" || !path) continue;
    if (EDIT_TOOLS.test(block.name ?? "")) out.push({ path, edited: true });
    else if (READ_TOOLS.test(block.name ?? "")) out.push({ path, edited: false });
  }
  return out;
}

const HOME = homedir();
/** Agents' own state, caches and scratch space: reading these says nothing about the task. */
const AGENT_STATE = [`${HOME}/.claude/`, `${HOME}/.codex/`, `${HOME}/.grok/`, `${HOME}/.amp/`, `${HOME}/.cache/`, "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const NOT_TEXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|heic|pdf|mp[34]|mov|webm|wav|zip|tar|gz|tgz|bz2|xz|7z|lock|lockb|map|log|txt|woff2?|ttf|otf|wasm|so|dylib|dll|exe|bin|db|sqlite3?)$/i;

/** Whether a touched file can name the work: not agent state, not a binary, not a stray read. */
export function relevantFile(file: TouchedFile, root: string | null): boolean {
  const p = file.path;
  if (/(^|\/)(node_modules|dist|build|\.git|vendor|target)\//.test(p) || NOT_TEXT.test(p)) return false;
  if (AGENT_STATE.some((dir) => p.startsWith(dir))) return false;
  if (p.startsWith(`${HOME}/.pi/agent/`) && !(file.edited && p.includes("/extensions/"))) return false;
  // Outside the project, only edits count: an agent reads plenty of reference files elsewhere.
  if (root && p.startsWith("/") && !p.startsWith(root + "/") && !file.edited) return false;
  return true;
}

/** Ranks touched files: edits count three times a read, recent calls count more. */
export function rankFiles(touches: TouchedFile[], limit = 6, root: string | null = null): TouchedFile[] {
  const score = new Map<string, { file: TouchedFile; score: number }>();
  touches.forEach((t, i) => {
    if (!relevantFile(t, root)) return;
    const weight = (t.edited ? 3 : 1) * (1 + i / Math.max(1, touches.length));
    const hit = score.get(t.path);
    if (hit) {
      hit.score += weight;
      hit.file.edited ||= t.edited;
    } else score.set(t.path, { file: { ...t }, score: weight });
  });
  return [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.file);
}

export function sessionPrompts(path: string, root: string | null = null): SessionText {
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
  // Tool calls in the latest 400 transcript lines, oldest first, so recency can weigh them.
  const touches = tail.slice(-400).flatMap((line) => toolFiles(line));
  return { first, last: requests[0] ?? first, earlier: requests.slice(1), reply, files: rankFiles(touches, 6, root) };
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

/**
 * Your messages on an agent's screen, oldest first: lines after a `❯` or `›` prompt marker until
 * the next marker (muse, Claude Code). For agents without a transcript.
 */
export function screenRequests(output: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const raw of output.split("\n")) {
    const prompt = /^\s*[❯›]\s+(.*)$/u.exec(raw);
    if (prompt) {
      if (current?.length) out.push(current.join(" "));
      current = prompt[1]!.trim() ? [prompt[1]!.trim()] : null;
    } else if (/^\s*[◆●⏺•┃│▌✻✳─]/u.test(raw)) {
      if (current?.length) out.push(current.join(" "));
      current = null;
    } else if (current && raw.trim()) current.push(raw.trim());
  }
  if (current?.length) out.push(current.join(" "));
  return out.map((r) => r.replace(/\s+/g, " ")).filter(Boolean);
}

export async function collectPane(herdr: Herdr, pane: SnapshotPane, agentInfo: SnapshotPane | undefined, opts: CollectOptions): Promise<PaneContext> {
  const info = { ...pane, ...agentInfo };
  const cwd = info.foreground_cwd || info.cwd || null;
  const [proc, git] = await Promise.all([herdr.processInfo(pane.pane_id), cwd ? gitInfo(cwd) : Promise.resolve(null)]);
  const project = git ? basename(git.root) : cwd ? basename(cwd) : null;
  let subdir: string | null = null;
  if (git && cwd && cwd.startsWith(git.root + "/")) subdir = cwd.slice(git.root.length + 1);

  const sessionFile = info.agent ? sessionPath(info.agent_session, cwd) : null;
  const promptsRead = opts.sendPrompts && !!sessionFile;
  const session = promptsRead ? readSession(sessionFile!, git?.root ?? cwd) : EMPTY_SESSION;

  const command = info.agent ? null : foregroundCommand(proc?.foreground_processes);
  let title = info.terminal_title_stripped ?? info.terminal_title ?? null;
  // A title that repeats the command line may carry its secrets; send the redacted command instead.
  if (title && command && echoesCommand(tidy(title), command)) title = command.join(" ");
  return {
    ...sessionFields(session),
    sessionFile,
    promptsRead,
    commandGroup: command ? (proc?.foreground_process_group_id ?? null) : null,
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

const EMPTY_SESSION: SessionText = { first: null, last: null, earlier: [], reply: null, files: [] };

/** A transcript's requests and latest reply, or nothing if it can't be read. */
export function readSession(path: string, root: string | null = null): SessionText {
  try {
    return statSync(path).isFile() ? sessionPrompts(path, root) : EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

/** Transcript text as sent to Jev: clipped and redacted. */
export function sessionFields(session: SessionText): Pick<PaneContext, "firstPrompt" | "lastPrompt" | "earlierPrompts" | "lastReply" | "files"> {
  return {
    firstPrompt: clip(session.first, 1200),
    lastPrompt: clip(session.last, 1200),
    earlierPrompts: session.earlier.map((p) => clip(p, 400)!),
    lastReply: clip(session.reply, 800),
    files: session.files.map((f) => ({ ...f, path: redact(f.path) })).filter((f) => !f.path.includes("[redacted]")),
  };
}
