import { describe, expect, test } from "bun:test";
import type { PaneContext } from "../src/context";
import type { ChoiceAnswer, ClassifyResult } from "../src/jev";
import { commandTarget, decidePane, decideTab, keyphrases, paneRequest, pickWithHysteresis, tabRequest } from "../src/naming";

const opts = { separator: " · ", maxLength: 32, minProbability: 0.3, hysteresis: 0.15 };

function ctx(extra: Partial<PaneContext>): PaneContext {
  return {
    paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", label: null, agent: null, agentStatus: "unknown",
    titlePhrases: [], rawTitle: null, command: null, cwd: "/x/proj", project: "proj", subdir: null, branch: null,
    firstPrompt: null, lastPrompt: null, earlierPrompts: [], lastReply: null, sessionFile: null, files: [], promptsRead: false, commandGroup: null, output: "", ...extra,
  };
}

function choice(probabilities: Record<string, number>): ChoiceAnswer {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice, probabilities, confidence: probabilities[choice]! };
}

function result(answers: Record<string, Record<string, number>>): ClassifyResult {
  return { answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, choice(v)])) };
}

describe("keyphrases", () => {
  test("pulls topics out of a request", () => {
    const phrases = keyphrases("Please fix the meta hooks race condition in src/hooks/useMeta.ts when the session reloads");
    expect(phrases).toContain("useMeta.ts");
    expect(phrases.some((p) => p.toLowerCase().includes("hooks race"))).toBe(true);
    expect(phrases).not.toContain("the");
  });

  test("returns nothing for filler", () => {
    expect(keyphrases("how does this codebase look")).toEqual([]);
  });
});

describe("commandTarget", () => {
  test("names editor files, hosts and scripts", () => {
    expect(commandTarget(["nvim", "src/main.ts"])?.text).toBe("main.ts");
    expect(commandTarget(["ssh", "-p", "22", "deploy@prod-1"])?.text).toBe("prod-1");
    expect(commandTarget(["ssh", "deploy@prod-1"])?.text).toBe("prod-1");
    expect(commandTarget(["bun", "run", "dev"])?.text).toBe("dev");
    expect(commandTarget(["npm", "install"])).toBeNull();
    expect(commandTarget(["htop"])).toBeNull();
  });
});

describe("paneRequest", () => {
  test("skips an idle shell", () => {
    expect(paneRequest(ctx({}), "proj")).toBeNull();
  });

  test("asks about a terminal command", () => {
    const req = paneRequest(ctx({ command: ["bun", "run", "dev"], subdir: "packages/web" }), "proj")!;
    expect(req.kind).toBe("terminal");
    expect(Object.keys(req.questions).sort()).toEqual(["activity", "subject"]);
    const options = Object.keys((req.questions.subject as any).criteria);
    expect(options).toEqual(["dev", "web", "proj", "nothing specific"]);
    expect((req.state.pane as any).foreground_command).toBe("bun run dev");
  });

  test("asks an agent pane about its task", () => {
    const req = paneRequest(ctx({ agent: "amp", titlePhrases: ["Meta hooks race"], lastPrompt: "fix the race in the meta hooks" }), "proj")!;
    expect(req.kind).toBe("agent");
    expect(Object.keys(req.questions).sort()).toEqual(["subject", "task"]);
    expect(Object.keys((req.questions.subject as any).criteria)[0]).toBe("Meta hooks race");
    expect((req.questions.subject as any).criteria).not.toHaveProperty("nothing specific");
  });
});

describe("decidePane", () => {
  test("uses an agent's own title as the name", () => {
    const req = paneRequest(ctx({ agent: "amp", titlePhrases: ["Meta hooks race"] }), "proj")!;
    const d = decidePane(req, result({ task: { fix: 0.8, debug: 0.2 }, subject: { "Meta hooks race": 0.9, proj: 0.1 } }), {}, "proj", opts);
    expect(d.name).toBe("Meta hooks race");
    expect(d.confident).toBe(true);
  });

  test("combines the task verb with a topic", () => {
    const req = paneRequest(ctx({ agent: "pi", lastPrompt: "review the websocket reconnect logic" }), "proj")!;
    const topic = Object.keys((req.questions.subject as any).criteria).find((o) => o.includes("websocket"))!;
    const d = decidePane(req, result({ task: { review: 0.85, fix: 0.15 }, subject: { [topic]: 0.7, proj: 0.3 } }), {}, "proj", opts);
    expect(d.name).toBe(`review ${topic}`);
  });

  test("names a terminal by activity and drops a subject the workspace already shows", () => {
    const req = paneRequest(ctx({ command: ["bun", "test", "--watch"] }), "proj")!;
    const d1 = decidePane(req, result({ activity: { tests: 0.9, run: 0.1 }, subject: { proj: 0.8, "nothing specific": 0.2 } }), {}, "proj", opts);
    expect(d1.name).toBe("tests");
    const req2 = paneRequest(ctx({ command: ["bun", "run", "dev"], subdir: "packages/web" }), "proj")!;
    const d2 = decidePane(req2, result({ activity: { server: 0.9, run: 0.1 }, subject: { web: 0.7, dev: 0.3 } }), {}, "proj", opts);
    expect(d2.name).toBe("server · web");
  });

  test("leaves a shell unnamed when nothing specific stands out", () => {
    const req = paneRequest(ctx({ command: ["ls"] }), "proj")!;
    const d = decidePane(req, result({ activity: { shell: 0.9, run: 0.1 }, subject: { "nothing specific": 0.9, proj: 0.1 } }), {}, "proj", opts);
    expect(d.name).toBeNull();
  });

  test("is not confident below the minimum probability", () => {
    const req = paneRequest(ctx({ command: ["bun", "run", "dev"] }), "proj")!;
    const d = decidePane(req, result({ activity: { server: 0.28, run: 0.26, build: 0.24, tests: 0.22 }, subject: { dev: 0.9, proj: 0.1 } }), {}, "proj", opts);
    expect(d.confident).toBe(false);
  });

  test("keeps the previous subject when the new one barely wins", () => {
    const pick = pickWithHysteresis(choice({ a: 0.5, b: 0.45, c: 0.05 }), "b", 0.15);
    expect(pick).toEqual({ value: "b", probability: 0.45, kept: true });
    expect(pickWithHysteresis(choice({ a: 0.8, b: 0.15 }), "b", 0.15).value).toBe("a");
    expect(pickWithHysteresis(choice({ a: 0.8, b: 0.15 }), "gone", 0.15).value).toBe("a");
  });
});

describe("tabs", () => {
  const panes = [
    { name: "Meta hooks race", agent: "amp", doing: "fix", subject: "Meta hooks race", project: "proj", branch: null, title: "Meta hooks race" },
    { name: "tests", agent: null, doing: "tests", subject: null, project: "proj", branch: "feat/hooks", title: null },
  ];

  test("offers pane names, subjects and branches but not the workspace name", () => {
    const req = tabRequest(panes, "proj", ["1"])!;
    expect(req.options).toEqual(["Meta hooks race", "tests", "hooks"]);
  });

  test("avoids a name another tab already has", () => {
    const d = decideTab(choice({ "Meta hooks race": 0.6, hooks: 0.3, tests: 0.1 }), null, ["Meta hooks race"], { ...opts, maxLength: 24 });
    expect(d.name).toBe("hooks");
  });
});
