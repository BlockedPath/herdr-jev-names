/**
 * Names for idle shells from the agent that last ran in them. While an agent runs, the engine
 * remembers its transcript and title. Agents that exited before the plugin saw them are found
 * through the resume hint they print on exit: an Amp thread link, `claude --resume <id>`,
 * `codex resume <id>`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionPath } from "./context";
import { run } from "./herdr";

export interface LastAgent {
  agent: string;
  /** Transcript path, for pi, Claude Code and Codex. */
  session?: string | null;
  /** The agent's own task title, e.g. an Amp thread title. */
  title?: string | null;
}

export interface ResumeHint {
  agent: "amp" | "claude" | "codex";
  id: string;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const HINTS: Array<[ResumeHint["agent"], RegExp]> = [
  ["amp", new RegExp(`ampcode\\.com/threads/(T-${UUID})`, "g")],
  ["amp", new RegExp(`amp threads (?:continue|c) (T-${UUID})`, "g")],
  ["claude", new RegExp(`claude (?:--resume|-r) (${UUID})`, "g")],
  ["codex", new RegExp(`codex resume (${UUID})`, "g")],
];

/** The resume hint printed last in the output, i.e. the most recent agent to exit. */
export function resumeHint(output: string): ResumeHint | null {
  let best: { hint: ResumeHint; at: number } | null = null;
  for (const [agent, re] of HINTS) {
    for (const m of output.matchAll(re)) {
      if (!best || m.index! > best.at) best = { hint: { agent, id: m[1]! }, at: m.index! };
    }
  }
  return best?.hint ?? null;
}

function findAmp(): string | null {
  const home = homedir();
  for (const p of [process.env.AMP_BIN, Bun.which("amp"), join(home, ".amp/bin/amp"), join(home, ".local/bin/amp"), "/opt/homebrew/bin/amp", "/usr/local/bin/amp"]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

let ampThreads: Promise<Map<string, string>> | null = null;

/** The title of an Amp thread, from `amp threads list` (one call per process). */
export async function ampThreadTitle(id: string): Promise<string | null> {
  ampThreads ??= (async () => {
    const amp = findAmp();
    const titles = new Map<string, string>();
    if (!amp) return titles;
    const res = await run([amp, "threads", "list", "--json", "--limit", "200"], 10_000).catch(() => null);
    if (!res || res.code !== 0) return titles;
    try {
      for (const t of JSON.parse(res.stdout) as Array<{ id?: string; title?: string }>) if (t.id && t.title) titles.set(t.id, t.title);
    } catch {
      // not JSON: an old amp, or a login prompt
    }
    return titles;
  })();
  return (await ampThreads).get(id) ?? null;
}

/** What the last agent in a pane left behind, from memory or from the scrollback. */
export async function findLastAgent(remembered: LastAgent | null | undefined, output: string, cwd: string | null): Promise<LastAgent | null> {
  if (remembered && (remembered.title || remembered.session)) return remembered;
  const hint = resumeHint(output);
  if (!hint) return null;
  if (hint.agent === "amp") {
    const title = await ampThreadTitle(hint.id);
    return title ? { agent: "amp", title } : null;
  }
  const session = sessionPath({ agent: hint.agent, kind: "id", source: "scrollback", value: hint.id }, cwd);
  return session ? { agent: hint.agent, session } : null;
}
