import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/engine";
import { sweep } from "../src/engine";
import { resumeHint } from "../src/lastagent";
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
});
