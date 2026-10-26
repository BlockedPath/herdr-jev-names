import type { Herdr, ProcessInfo, ReadSource, Snapshot, SnapshotPane, SnapshotTab } from "../src/herdr";
import type { ClassifyResult, Classifier, Question } from "../src/jev";

export class FakeHerdr implements Herdr {
  renames: Array<[string, string]> = [];
  notes: string[] = [];
  processes = new Map<string, ProcessInfo>();
  outputs = new Map<string, string>();
  reads: Array<[string, ReadSource]> = [];

  constructor(public snap: Snapshot) {}

  async snapshot(): Promise<Snapshot> {
    return structuredClone(this.snap);
  }
  async processInfo(paneId: string): Promise<ProcessInfo | null> {
    return this.processes.get(paneId) ?? { foreground_processes: [{ argv: ["-zsh"], name: "zsh" }] };
  }
  async read(paneId: string, _lines: number, source: ReadSource): Promise<string> {
    this.reads.push([paneId, source]);
    return this.outputs.get(paneId) ?? "";
  }
  async renamePane(paneId: string, label: string): Promise<void> {
    this.renames.push([paneId, label]);
    const p = this.snap.panes.find((x) => x.pane_id === paneId);
    if (p) p.label = label;
  }
  async clearPaneLabel(paneId: string): Promise<void> {
    this.renames.push([paneId, ""]);
    const p = this.snap.panes.find((x) => x.pane_id === paneId);
    if (p) p.label = null;
  }
  async renameTab(tabId: string, label: string): Promise<void> {
    this.renames.push([tabId, label]);
    const t = this.snap.tabs.find((x) => x.tab_id === tabId);
    if (t) t.label = label;
  }
  async notify(_title: string, body: string): Promise<void> {
    this.notes.push(body);
  }
}

type Picker = (questionId: string, options: string[], state: any) => Record<string, number> | string;

/** Answers every choice question; `pick` returns the chosen option or a probability map. */
export class FakeJev implements Classifier {
  calls: Array<{ state: any; questions: Record<string, Question> }> = [];
  constructor(public pick: Picker = (_q, options) => options[0]!) {}

  async classify(state: unknown, questions: Record<string, Question>): Promise<ClassifyResult> {
    this.calls.push({ state, questions });
    const answers: ClassifyResult["answers"] = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== "choice") continue;
      const options = Object.keys(q.criteria);
      const picked = this.pick(id, options, state);
      const probabilities: Record<string, number> = {};
      if (typeof picked === "string") {
        for (const o of options) probabilities[o] = o === picked ? 0.9 : 0.1 / Math.max(1, options.length - 1);
      } else {
        for (const o of options) probabilities[o] = picked[o] ?? 0;
      }
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      answers[id] = { type: "choice", choice, probabilities, confidence: probabilities[choice]! };
    }
    return { answers };
  }
}

export function pane(id: string, tab: string, extra: Partial<SnapshotPane> = {}): SnapshotPane {
  const ws = id.split(":")[0]!;
  return { pane_id: id, tab_id: tab, workspace_id: ws, cwd: "/nonexistent/proj", foreground_cwd: "/nonexistent/proj", agent_status: "unknown", ...extra };
}

export function tab(id: string, label: string, paneCount = 1): SnapshotTab {
  return { tab_id: id, workspace_id: id.split(":")[0]!, label, number: 1, pane_count: paneCount };
}

export function snapshot(panes: SnapshotPane[], tabs: SnapshotTab[], workspaces = [{ workspace_id: "w1", label: "proj", number: 1 }]): Snapshot {
  return { panes, agents: panes.filter((p) => p.agent), tabs, workspaces };
}
