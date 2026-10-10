import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/engine";
import { sweep } from "../src/engine";
import { agentProgram } from "../src/context";
import { findLastAgent, resumeHint } from "../src/lastagent";
import type { PaneEntry } from "../src/state";
import { Store } from "../src/state";
import { FakeHerdr, FakeJev, pane, snapshot, tab } from "./fakes";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jevnames-last-"));
});

function deps(herdr: FakeHerdr, jev: FakeJev | null): Deps {
  const cfg = loadConfig({ HOME: "/nonexistent", HERDR_PLUGIN_CONFIG_DIR: join(stateDir, "config"), HERDR_PLUGIN_STATE_DIR: stateDir });
  return { herdr, jev, store: new Store(stateDir, "last"), cfg };
}

function seed(panes: Record<string, PaneEntry>) {
  new Store(stateDir, "last").save({ version: 1, panes, tabs: {} });
}

const picker = (q: string, options: string[]) => (q === "task" ? "fix" : options.find((o) => o === "clef") ?? options[0]!);

describe("resumeHint", () => {
  test("finds the last agent's resume hint in the scrollback", () => {
    const id = "01a1278c-09e5-7753-b5d3-464ba25ac3f8";
    expect(resumeHint(`amp threads continue https://ampcode.com/threads/T-${id}\n❯`)).toEqual({ agent: "amp", id: `T-${id}` });
    expect(resumeHint(`To continue this session, run codex resume ${id}`)).toEqual({ agent: "codex", id });
    expect(resumeHint(`ampcode.com/threads/T-${id}\nlater: claude --resume ${id}`)).toEqual({ agent: "claude", id });
    expect(resumeHint("just a prompt ❯")).toBeNull();
  });
});

describe("idle shells", () => {
  test("keep the name the agent's task had after it exits", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.agent = null;
    herdr.snap.panes[0]!.terminal_title_stripped = null;
    herdr.snap.agents = [];
    herdr.renames = [];
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toEqual([]);
    expect(herdr.snap.panes[0]!.label).toBe("Meta hooks race");
  });

  test("are named after an agent that exited before it was named", async () => {
    seed({ "w1:p1": { lastAgent: { agent: "amp", title: "Pi-meta-oauth 0.7.2 release" } } });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "new orb" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames).toEqual([
      ["w1:p1", "Pi-meta-oauth 0.7.2 release"],
      ["w1:t1", "Pi-meta-oauth 0.7.2…"],
    ]);
  });

  test("ask Jev about the last agent's transcript", async () => {
    const file = join(stateDir, "pi.jsonl");
    const msg = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    writeFileSync(file, [msg("try now for clef"), msg("so its working now?"), ""].join("\n"));
    seed({ "w1:p1": { lastAgent: { agent: "pi", session: file } } });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1")], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames[0]).toEqual(["w1:p1", "fix clef"]);
    expect(jev.calls[0]!.questions.task).toBeDefined();
  });

  test("clear a placeholder an exited agent left when there is nothing to name", async () => {
    seed({ "w1:p1": { lastAgent: { agent: "amp" } } });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "new orb" })], [tab("w1:t1", "1")]));
    const decisions = await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames).toEqual([["w1:p1", ""]]);
    expect(decisions[0]).toMatchObject({ action: "cleared" });
  });

  test("leave a placeholder alone while its agent has not started", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "new orb" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames).toEqual([]);
  });

  test("an agent that is exiting keeps its task name instead of becoming a generic terminal", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Codebase bug review - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev((q, options) => (q === "activity" ? "run" : q === "task" ? "review" : options[0]!));
    await sweep(deps(herdr, jev), { dryRun: false });
    // herdr has dropped the agent, but amp is still the foreground process.
    herdr.snap.panes[0]!.agent = null;
    herdr.snap.agents = [];
    herdr.processes.set("w1:p1", { foreground_processes: [{ argv: ["amp"], name: "amp" }] });
    herdr.renames = [];
    await sweep(deps(herdr, jev), { dryRun: false, reevaluate: true });
    expect(herdr.renames).toEqual([]);
  });

  test("a tab does not copy a one-letter pane label", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "pi", label: "f" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames).toEqual([]);
  });
});

describe("second review", () => {
  const id = "01a1278c-09e5-7753-b5d3-464ba25ac3f8";

  test("an Amp thread link in git log output is not a resume hint", async () => {
    expect(resumeHint(`commit 9ab975f\n    Amp-Thread-ID: https://ampcode.com/threads/T-${id}\n❯`)).toBeNull();
    expect(resumeHint(`or run 'amp threads continue T-${id}'`)).toEqual({ agent: "amp", id: `T-${id}` });
    // A remembered pi with nothing to go on does not take an Amp hint.
    expect(await findLastAgent({ agent: "pi" }, `amp threads continue T-${id}`, null)).toBeNull();
  });

  test("agents are recognized behind package runners", () => {
    expect(agentProgram(["npx", "-y", "@openai/codex@latest"])).toBe("codex");
    expect(agentProgram(["bun", "x", "@anthropic-ai/claude-code"])).toBe("claude");
    expect(agentProgram(["pnpm", "dlx", "opencode"])).toBe("opencode");
    expect(agentProgram(["bun", "run", "dev"])).toBeNull();
    expect(agentProgram(["aider", "--model", "sonnet"])).toBe("aider");
  });

  test("an agent herdr can't detect is named as an agent, not frozen", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { terminal_title_stripped: "Fix login redirect" })], [tab("w1:t1", "1")]));
    herdr.processes.set("w1:p1", { foreground_processes: [{ argv: ["aider", "--model", "sonnet"], name: "aider" }] });
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(jev.calls[0]!.questions.task).toBeDefined();
    expect(herdr.renames[0]).toEqual(["w1:p1", "Fix login redirect"]);
  });

  test("name-here still names a pane while its agent is starting", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    herdr.processes.set("w1:p1", { foreground_processes: [{ argv: ["amp"], name: "amp" }] });
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toEqual([]);
    await sweep(deps(herdr, jev), { dryRun: false, forcePanes: new Set(["w1:p1"]), forceTabs: new Set(["w1:t1"]), unlock: true });
    expect(herdr.renames[0]).toEqual(["w1:p1", "Meta hooks race"]);
  });

  test("a tab named after a pane that closed goes back to its number", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Codebase bug review - amp" }), pane("w1:p2", "w1:t1", { agent: "pi", label: "f" })], [tab("w1:t1", "1", 2)]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.snap.tabs[0]!.label).toBe("Codebase bug review");
    herdr.snap.panes = herdr.snap.panes.filter((p) => p.pane_id !== "w1:p1");
    herdr.snap.agents = herdr.snap.panes;
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.snap.tabs[0]!.label).toBe("1");
  });

  test("a placeholder tab is reset once its orb pane's placeholder is cleared", async () => {
    seed({ "w1:p1": { lastAgent: { agent: "amp" } } });
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "new orb" })], [tab("w1:t1", "new orb")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.snap.panes[0]!.label).toBeNull();
    expect(herdr.snap.tabs[0]!.label).toBe("1");
  });

  test("a new orb tab keeps its placeholder until the agent has run", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { label: "new orb" })], [tab("w1:t1", "new orb")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames).toEqual([]);
  });

  test("a number typed over the plugin's tab name is kept", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.tabs[0]!.label = "3";
    herdr.renames = [];
    const decisions = await sweep(deps(herdr, jev), { dryRun: false, reevaluate: true });
    expect(herdr.renames).toEqual([]);
    expect(decisions.find((d) => d.kind === "tab")?.action).toBe("locked");
  });
});
