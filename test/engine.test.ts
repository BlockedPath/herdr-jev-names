import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/engine";
import { sweep } from "../src/engine";
import { plan } from "../src/main";
import { ownership, Store } from "../src/state";
import { FakeHerdr, FakeJev, pane, snapshot, tab } from "./fakes";

let stateDir: string;

function deps(herdr: FakeHerdr, jev: FakeJev | null, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ HOME: "/nonexistent", HERDR_PLUGIN_CONFIG_DIR: join(stateDir, "config"), HERDR_PLUGIN_STATE_DIR: stateDir, ...env });
  return { herdr, jev, store: new Store(stateDir, "test-socket"), cfg };
}

/** Picks the agent title or the first option, and "tests" for terminals running bun test. */
const picker = (q: string, options: string[], state: any) => {
  if (q === "activity") return state.pane.foreground_command?.includes("test") ? "tests" : "server";
  if (q === "task") return "fix";
  return options[0]!;
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jevnames-state-"));
});

describe("ownership", () => {
  const isDefault = (l: string) => /^\d+$/.test(l);
  test("free, ours and foreign labels", () => {
    expect(ownership(null, undefined, isDefault)).toBe("free");
    expect(ownership("3", undefined, isDefault)).toBe("free");
    expect(ownership("mine", { auto: "mine" }, isDefault)).toBe("ours");
    expect(ownership("hand named", { auto: "mine" }, isDefault)).toBe("foreign");
    expect(ownership("hand named", undefined, isDefault)).toBe("foreign");
    expect(ownership(null, { auto: "mine" }, isDefault)).toBe("foreign"); // cleared by the user
    expect(ownership("mine", { auto: "mine", locked: true }, isDefault)).toBe("foreign");
  });
});

describe("sweep", () => {
  test("names an agent pane and its single-pane tab", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", agent_status: "done", terminal_title_stripped: "Meta hooks race - amp - ~/dev/proj" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    const decisions = await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toEqual([
      ["w1:p1", "Meta hooks race"],
      ["w1:t1", "Meta hooks race"],
    ]);
    expect(jev.calls.length).toBe(1); // a single-pane tab reuses the pane name
    expect(decisions.filter((d) => d.action === "renamed").length).toBe(2);
  });

  test("does not call Jev again when nothing changed", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(jev.calls.length).toBe(1);
    herdr.snap.panes[0]!.terminal_title_stripped = "Websocket retry - amp";
    herdr.snap.agents = herdr.snap.panes;
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(jev.calls.length).toBe(2);
    expect(herdr.renames.at(-2)).toEqual(["w1:p1", "Websocket retry"]);
    expect(herdr.renames.at(-1)).toEqual(["w1:t1", "Websocket retry"]);
  });

  test("leaves labels someone else set, until name-here takes them back", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", label: "my pane", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "my tab")]));
    const jev = new FakeJev(picker);
    const d1 = await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toEqual([]);
    expect(d1.map((d) => d.action)).toEqual(["locked", "locked"]);

    await sweep(deps(herdr, jev), plan([{ type: "name-here", paneId: "w1:p1", tabId: "w1:t1" }], false));
    expect(herdr.renames).toEqual([
      ["w1:p1", "Meta hooks race"],
      ["w1:t1", "Meta hooks race"],
    ]);
  });

  test("stops renaming after the user renames an auto-named pane", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.label = "renamed by hand";
    herdr.snap.panes[0]!.terminal_title_stripped = "Something else - amp";
    herdr.snap.agents = herdr.snap.panes;
    herdr.renames = [];
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames.find(([id]) => id === "w1:p1")).toBeUndefined();
  });

  test("replaces placeholder labels from other plugins", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", label: "new orb", terminal_title_stripped: "Code bug review - amp" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker)), { dryRun: false });
    expect(herdr.renames[0]).toEqual(["w1:p1", "Code bug review"]);
  });

  test("dry run changes nothing and saves no state", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    const decisions = await sweep(deps(herdr, jev), { dryRun: true });
    expect(herdr.renames).toEqual([]);
    expect(decisions.map((d) => [d.kind, d.action, d.to])).toEqual([
      ["pane", "would-rename", "Meta hooks race"],
      ["tab", "would-rename", "Meta hooks race"],
    ]);
    await sweep(deps(herdr, jev), { dryRun: true });
    expect(jev.calls.length).toBe(2);
  });

  test("names a multi-pane tab through Jev and skips idle shells", async () => {
    const herdr = new FakeHerdr(
      snapshot(
        [
          pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" }),
          pane("w1:p2", "w1:t1"),
          pane("w1:p3", "w1:t1"),
        ],
        [tab("w1:t1", "1", 3)],
      ),
    );
    herdr.processes.set("w1:p3", { foreground_processes: [{ argv: ["bun", "test", "--watch"], name: "bun" }] });
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toContainEqual(["w1:p1", "Meta hooks race"]);
    expect(herdr.renames).toContainEqual(["w1:p3", "tests"]);
    expect(herdr.renames.find(([id]) => id === "w1:p2")).toBeUndefined();
    // Reading an agent's scrollback can make herdr scroll its screen; shells keep their scrollback.
    expect(herdr.reads.sort()).toEqual([
      ["w1:p1", "visible"],
      ["w1:p2", "recent-unwrapped"],
      ["w1:p3", "recent-unwrapped"],
    ]);
    const tabCall = jev.calls.find((c) => "label" in c.questions)!;
    expect(Object.keys((tabCall.questions.label as any).criteria)).toEqual(["Meta hooks race", "tests"]);
    expect(herdr.renames.at(-1)).toEqual(["w1:t1", "Meta hooks race"]);
  });

  test("follows a pane that moved to a new id", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const jev = new FakeJev(picker);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.pane_id = "w1:p9";
    herdr.snap.panes[0]!.tab_id = "w1:t2";
    herdr.snap.tabs = [tab("w1:t2", "2")];
    herdr.snap.agents = herdr.snap.panes;
    herdr.renames = [];
    const opts = plan([{ type: "event", event: "pane.moved", data: { previous_pane_id: "w1:p1", pane: { pane_id: "w1:p9" } } }], false);
    const decisions = await sweep(deps(herdr, jev), opts);
    expect(decisions.find((d) => d.kind === "pane")?.action).not.toBe("locked");
    expect(herdr.renames).toEqual([["w1:t2", "Meta hooks race"]]);
  });

  test("records an error and keeps going when Jev fails", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    const failing = new FakeJev();
    failing.classify = async () => {
      throw new Error("Jev returned 529");
    };
    const decisions = await sweep(deps(herdr, failing), { dryRun: false });
    expect(decisions[0]).toMatchObject({ kind: "pane", action: "error" });
    expect(herdr.renames).toEqual([]);
  });

  test("respects JEV_NAMES_TABS=0", async () => {
    const herdr = new FakeHerdr(snapshot([pane("w1:p1", "w1:t1", { agent: "amp", terminal_title_stripped: "Meta hooks race - amp" })], [tab("w1:t1", "1")]));
    await sweep(deps(herdr, new FakeJev(picker), { JEV_NAMES_TABS: "0" }), { dryRun: false });
    expect(herdr.renames).toEqual([["w1:p1", "Meta hooks race"]]);
  });
});

describe("queue", () => {
  test("drains queued items once", () => {
    const store = new Store(stateDir, "q");
    store.enqueue({ type: "name-all" });
    store.enqueue({ type: "event", event: "pane.created" });
    expect(store.hasPending()).toBe(true);
    expect(store.drain().map((i) => i.type)).toEqual(["name-all", "event"]);
    expect(store.hasPending()).toBe(false);
    expect(store.drain()).toEqual([]);
  });

  test("locks are exclusive and dead holders are broken", () => {
    const a = new Store(stateDir, "l");
    expect(a.tryLock()).toBe(true);
    expect(new Store(stateDir, "l").tryLock()).toBe(false);
    a.unlock();
    expect(new Store(stateDir, "l").tryLock()).toBe(true);
  });
});
