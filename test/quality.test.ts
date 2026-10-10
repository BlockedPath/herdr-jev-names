/** Better names: sticky specific names, no guessing for idle agents, topics from touched files. */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { PaneContext } from "../src/context";
import { agentScreen, rankFiles, relevantFile, screenRequests, sessionPrompts, toolFiles } from "../src/context";
import type { Deps } from "../src/engine";
import { sweep } from "../src/engine";
import { fileTopics, paneRequest } from "../src/naming";
import { Store } from "../src/state";
import { FakeHerdr, FakeJev, pane, snapshot, tab } from "./fakes";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jevnames-quality-"));
});

function deps(herdr: FakeHerdr, jev: FakeJev): Deps {
  const cfg = loadConfig({ HOME: "/nonexistent", HERDR_PLUGIN_CONFIG_DIR: join(stateDir, "config"), HERDR_PLUGIN_STATE_DIR: stateDir });
  return { herdr, jev, store: new Store(stateDir, "quality"), cfg };
}

function ctx(extra: Partial<PaneContext>): PaneContext {
  return {
    paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", label: null, agent: null, agentStatus: "unknown",
    titlePhrases: [], rawTitle: null, command: null, cwd: "/x/proj", project: "proj", subdir: null, branch: null,
    firstPrompt: null, lastPrompt: null, earlierPrompts: [], lastReply: null, sessionFile: null, files: [], promptsRead: false, commandGroup: null, output: "", ...extra,
  };
}

const picker = (q: string, options: string[]) => (q === "task" ? "fix" : q === "activity" ? "git" : options[0]!);

describe("specific names stick", () => {
  test("a quick git command after an agent exits doesn't replace the agent's name", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Fix clef gate - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("Fix clef gate");
    herdr.snap.panes[0]!.agent = null;
    herdr.snap.panes[0]!.terminal_title_stripped = null;
    herdr.snap.agents = [];
    herdr.processes.set("w1:p1", { foreground_processes: [{ argv: ["git", "status"], name: "git" }] });
    const decisions = await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("Fix clef gate");
    expect(decisions.find((d) => d.kind === "pane")?.reason).toContain("more specific");
  });

  test("a command that keeps running does take over", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Fix clef gate - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.agent = null;
    herdr.snap.panes[0]!.terminal_title_stripped = null;
    herdr.snap.agents = [];
    herdr.processes.set("w1:p1", { foreground_processes: [{ argv: ["lazygit"], name: "lazygit" }] });
    await sweep(deps(herdr, jev), { dryRun: false });
    // Pretend lazygit has been open for a minute.
    const store = new Store(stateDir, "quality");
    const state = store.load();
    state.panes["w1:p1"]!.command!.since -= 60_000;
    store.save(state);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("git");
  });
});

describe("agents with nothing to go on", () => {
  test("an agent nobody has asked anything is not named", () => {
    expect(paneRequest(ctx({ agent: "pi", promptsRead: true, output: "pi-lens grok-4.7 ctx 0.0%" }), "proj")).toBeNull();
    expect(paneRequest(ctx({ agent: "pi", promptsRead: true, lastPrompt: "hi" }), "proj")).not.toBeNull();
  });

  test("agents whose requests can't be read are still named from what is available", () => {
    const req = paneRequest(ctx({ agent: "gemini", promptsRead: false, branch: "fix/login-redirect" }), "work")!;
    expect(Object.keys((req.questions.subject as any).criteria)).toContain("login redirect");
  });
});

describe("topics from touched files", () => {
  test("reads edits and reads from pi, Claude Code and Codex transcripts", () => {
    const pi = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "/x/proj/src/payload.ts" } }] } });
    const claude = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/proj/src/catalog.ts" } }] } });
    const codex = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.apply_patch("*** Begin Patch\\n*** Update File: /x/proj/lib/brand/store.ts\\n+x")' } });
    expect(toolFiles(pi)).toEqual([{ path: "/x/proj/src/payload.ts", edited: true }]);
    expect(toolFiles(claude)).toEqual([{ path: "/x/proj/src/catalog.ts", edited: false }]);
    expect(toolFiles(codex)).toEqual([{ path: "/x/proj/lib/brand/store.ts", edited: true }]);
  });

  test("edits outrank reads, and recent calls outrank old ones", () => {
    const ranked = rankFiles([
      { path: "a.ts", edited: false },
      { path: "a.ts", edited: false },
      { path: "b.ts", edited: true },
      { path: "node_modules/x/index.js", edited: true },
    ]);
    expect(ranked.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
  });

  test("offers file names, qualified generic names and a shared folder", () => {
    const topics = fileTopics(
      [
        { path: "/x/proj/src/auth/session.ts", edited: true },
        { path: "/x/proj/src/auth/index.ts", edited: true },
        { path: "/x/proj/README.md", edited: false },
      ],
      "/x/proj",
    ).map((t) => t.text);
    expect(topics).toEqual(["session.ts", "auth/index.ts", "README.md", "auth"]);
  });

  test("a vague request still gets a topic from the edited files", () => {
    const req = paneRequest(ctx({ agent: "pi", lastPrompt: "do it again", files: [{ path: "/x/proj/src/payload.ts", edited: true }] }), "proj")!;
    expect(Object.keys((req.questions.subject as any).criteria)).toContain("payload.ts");
    expect((req.state.pane as any).files_edited).toEqual(["/x/proj/src/payload.ts"]);
  });

  test("sessionPrompts returns the ranked files", () => {
    const file = join(stateDir, "s.jsonl");
    const call = (name: string, path: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: { path } }] } });
    const msg = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix it" }] } });
    writeFileSync(file, [msg, call("read", "/x/proj/a.ts"), call("edit", "/x/proj/b.ts"), ""].join("\n"));
    expect(sessionPrompts(file).files).toEqual([
      { path: "/x/proj/b.ts", edited: true },
      { path: "/x/proj/a.ts", edited: false },
    ]);
  });
});

describe("bare names on idle shells", () => {
  test("give way to the last agent's more specific name", async () => {
    const file = join(stateDir, "pi.jsonl");
    const msg = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    writeFileSync(file, [msg("try now for clef"), ""].join("\n"));
    const store = new Store(stateDir, "quality");
    store.save({ version: 1, panes: { "w1:p1": { auto: "git", what: "git", subject: null, lastAgent: { agent: "pi", session: file } } }, tabs: {} });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "git" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev((q, options) => (q === "task" ? "fix" : options.includes("clef") ? "clef" : options[0]!))), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("fix clef");
  });

  test("are kept when there is nothing better", async () => {
    const store = new Store(stateDir, "quality");
    store.save({ version: 1, panes: { "w1:p1": { auto: "setup", what: "setup", subject: null, lastAgent: { agent: "pi", session: null, title: null } } }, tabs: {} });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "setup" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("setup");
  });
});

describe("third review", () => {
  const muse = [
    "❯ what does this mean",
    "  warning: rules file at",
    "  /Users/justin/dev/bou",
    "  nty/CLAUDE",
    "  .md is ignored",
    "◆ That warning means only one",
    "  file is being used.",
    "  Read 2 files · ctrl+o",
    "◆ Read skill create-rul",
    "e · user · 3 KB",
    "◆ You have both AGENTS.md and",
    "  CLAUDE.md in this folder.",
    "❯ no",
    "◆ Got it — leaving both files.",
    "── Voice input (⌥ + v…",
    "  muse-spark-1.3-contr…",
  ].join("\n");

  test("muse's screen gives your messages and the replies, without tool calls or chrome", () => {
    expect(screenRequests(muse)).toEqual(["what does this mean warning: rules file at /Users/justin/dev/bou nty/CLAUDE .md is ignored", "no"]);
    const screen = agentScreen(muse);
    expect(screen).toContain("CLAUDE.md is ignored");
    expect(screen).not.toContain("create-rul");
    expect(screen).not.toContain("muse-spark");
  });

  test("a diff pasted into a prompt is not an edit", () => {
    const pasted = JSON.stringify({ type: "user", message: { role: "user", content: "see this *** Update File: src/a.ts" } });
    expect(toolFiles(pasted)).toEqual([]);
  });

  test("agent state, scratch space, binaries and stray reads don't name the work", () => {
    const home = process.env.HOME!;
    expect(relevantFile({ path: `${home}/.claude/projects/x/memory.md`, edited: false }, "/x/proj")).toBe(false);
    expect(relevantFile({ path: "/tmp/scratch.ts", edited: true }, "/x/proj")).toBe(false);
    expect(relevantFile({ path: "/x/proj/shot.png", edited: false }, "/x/proj")).toBe(false);
    expect(relevantFile({ path: "/elsewhere/ref.md", edited: false }, "/x/proj")).toBe(false);
    expect(relevantFile({ path: "/elsewhere/config.toml", edited: true }, "/x/proj")).toBe(true);
    expect(relevantFile({ path: "/x/proj/src/a.ts", edited: false }, "/x/proj")).toBe(true);
  });

  test("a new agent session doesn't inherit the old session's sticky name", async () => {
    const dir = stateDir;
    const msg = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, msg("fix the clef gate") + "\n");
    writeFileSync(b, msg("what does this repo do") + "\n");
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "pi", agent_session: { agent: "pi", kind: "path", source: "t", value: a } })], [tab("w1:t1", "1")]));
    const asksAboutClef = (state: any) => JSON.stringify(state).includes("clef");
    const jev = new FakeJev((q, options, state) => (q === "task" ? (asksAboutClef(state) ? "fix" : "explore") : options.find((o) => o === "clef gate") ?? options[options.length - 1]!));
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("fix clef gate");
    herdr.snap.panes[0]!.agent_session = { agent: "pi", kind: "path", source: "t", value: b };
    herdr.snap.agents = herdr.snap.panes;
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBe("explore");
  });

  test("a script keeps one start time while its children change", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1")], [tab("w1:t1", "1")]));
    herdr.processes.set("w1:p1", { foreground_process_group_id: 42, foreground_processes: [{ argv: ["bun", "test"], name: "bun" }] });
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    const since = new Store(stateDir, "quality").load().panes["w1:p1"]!.command!.since;
    herdr.processes.set("w1:p1", { foreground_process_group_id: 42, foreground_processes: [{ argv: ["sleep", "5"], name: "sleep" }] });
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(new Store(stateDir, "quality").load().panes["w1:p1"]!.command!.since).toBe(since);
  });

  test("the agent's own name is not a topic", () => {
    const req = paneRequest(ctx({ agent: "muse", output: "❯ what can muse do here\n◆ Muse can list skills and run the TinyFish search" }), "proj")!;
    const options = Object.keys((req.questions.subject as any).criteria);
    expect(options.map((o) => o.toLowerCase())).not.toContain("muse");
  });
});
