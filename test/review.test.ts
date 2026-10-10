/** Regression tests for issues found in review. */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { PaneContext } from "../src/context";
import { branchTopic, echoesCommand, redactArgv, titlePhrases, userRequest } from "../src/context";
import type { Deps } from "../src/engine";
import { sweep } from "../src/engine";
import type { ChoiceAnswer, ClassifyResult } from "../src/jev";
import { plan } from "../src/main";
import { commandTarget, decidePane, keyphrases, paneRequest, tabRequest } from "../src/naming";
import { Store } from "../src/state";
import { cleanOutput, redact } from "../src/text";
import { FakeHerdr, FakeJev, pane, snapshot, tab } from "./fakes";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jevnames-review-"));
});

function deps(herdr: FakeHerdr, jev: FakeJev | null, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ HOME: "/nonexistent", HERDR_PLUGIN_CONFIG_DIR: join(stateDir, "config"), HERDR_PLUGIN_STATE_DIR: stateDir, ...env });
  return { herdr, jev, store: new Store(stateDir, "review"), cfg };
}

const firstOption = (q: string, options: string[]) => (q === "task" ? "fix" : q === "activity" ? "server" : options[0]!);

function amp(id: string, tabId: string, title: string, extra = {}) {
  return pane(id, tabId, { agent: "amp", terminal_title_stripped: `${title} - amp`, ...extra });
}

function ctx(extra: Partial<PaneContext>): PaneContext {
  return {
    paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", label: null, agent: null, agentStatus: "unknown",
    titlePhrases: [], rawTitle: null, command: null, cwd: "/x/proj", project: "proj", subdir: null, branch: null,
    firstPrompt: null, lastPrompt: null, earlierPrompts: [], lastReply: null, sessionFile: null, files: [], promptsRead: false, commandGroup: null, output: "", ...extra,
  };
}

function choice(probabilities: Record<string, number>): ChoiceAnswer {
  const c = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice: c, probabilities, confidence: probabilities[c]! };
}
const result = (answers: Record<string, Record<string, number>>): ClassifyResult => ({
  answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, choice(v)])),
});
const opts = { separator: " · ", maxLength: 32, minProbability: 0.3, hysteresis: 0.15 };

describe("state and locking", () => {
  test("a move that keeps the pane id does not lose the pane's state", async () => {
    const herdr = new FakeHerdr(snapshot([amp("w1:p1", "w1:t1", "Meta hooks race")], [tab("w1:t1", "1")]));
    const jev = new FakeJev(firstOption);
    await sweep(deps(herdr, jev), { dryRun: false });
    const moved = plan([{ type: "event", event: "pane.moved", data: { previous_pane_id: "w1:p1", pane: { pane_id: "w1:p1" } } }], false);
    const decisions = await sweep(deps(herdr, jev), moved);
    expect(decisions.find((d) => d.action === "locked")).toBeUndefined();
    herdr.snap.panes[0]!.terminal_title_stripped = "New task - amp";
    herdr.snap.agents = herdr.snap.panes;
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toContainEqual(["w1:p1", "New task"]);
  });

  test("a pane that moved to a new id is recognized by its label even without the move event", async () => {
    const herdr = new FakeHerdr(snapshot([amp("w1:p1", "w1:t1", "Meta hooks race")], [tab("w1:t1", "1")]));
    const jev = new FakeJev(firstOption);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.pane_id = "w2:p1";
    herdr.snap.panes[0]!.workspace_id = "w2";
    herdr.snap.panes[0]!.tab_id = "w2:t1";
    herdr.snap.tabs = [tab("w2:t1", "1")];
    herdr.snap.workspaces.push({ workspace_id: "w2", label: "other", number: 2 });
    herdr.snap.agents = herdr.snap.panes;
    const decisions = await sweep(deps(herdr, jev), { dryRun: false }); // e.g. a focus event drained first
    expect(decisions.find((d) => d.kind === "pane" && d.action === "locked")).toBeUndefined();
  });

  test("a failed rename is retried on the next sweep", async () => {
    const herdr = new FakeHerdr(snapshot([amp("w1:p1", "w1:t1", "Meta hooks race")], [tab("w1:t1", "1")]));
    const rename = herdr.renamePane.bind(herdr);
    let fail = true;
    herdr.renamePane = async (id, label) => {
      if (fail) throw new Error("herdr busy");
      return rename(id, label);
    };
    const jev = new FakeJev(firstOption);
    const d1 = await sweep(deps(herdr, jev), { dryRun: false });
    expect(d1[0]).toMatchObject({ kind: "pane", action: "error" });
    fail = false;
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.renames).toContainEqual(["w1:p1", "Meta hooks race"]);
  });

  test("a rename whose process died before saving is still recognized as the plugin's", async () => {
    const herdr = new FakeHerdr(snapshot([amp("w1:p1", "w1:t1", "Meta hooks race")], [tab("w1:t1", "1")]));
    const store = new Store(stateDir, "review");
    // What a crash right after `herdr pane rename` leaves behind: the pending name, and the label.
    store.save({ version: 1, panes: { "w1:p1": { pending: "Meta hooks race" } }, tabs: {} });
    herdr.snap.panes[0]!.label = "Meta hooks race";
    herdr.snap.agents = herdr.snap.panes;
    const decisions = await sweep(deps(herdr, new FakeJev(firstOption)), { dryRun: false });
    expect(decisions.find((d) => d.kind === "pane" && d.action === "locked")).toBeUndefined();
  });

  test("a live holder's lock is not taken over, and unlock never removes another process's lock", () => {
    const a = new Store(stateDir, "lock");
    expect(a.tryLock()).toBe(true);
    const lockDir = join(stateDir, `lock-${a.file.match(/state-(\w+)\.json/)![1]}`);
    const old = new Date(Date.now() - 30_000);
    utimesSync(lockDir, old, old);
    expect(new Store(stateDir, "lock").tryLock()).toBe(false); // holder alive, lock 30 s old
    // Someone else's lock: a stranger unlocking must leave it alone.
    const stranger = new Store(stateDir, "lock");
    stranger.unlock();
    expect(a.ownsLock()).toBe(true);
    a.unlock();
  });

  test("a lock left by a dead process is broken", () => {
    const s = new Store(stateDir, "dead");
    const lockDir = join(stateDir, `lock-${s.file.match(/state-(\w+)\.json/)![1]}`);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner"), "999999 dead-token");
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockDir, old, old);
    expect(s.tryLock()).toBe(true);
    s.unlock();
  });

  test("a process that lost its lock does not save", () => {
    const a = new Store(stateDir, "lost");
    expect(a.tryLock()).toBe(true);
    const lockDir = join(stateDir, `lock-${a.file.match(/state-(\w+)\.json/)![1]}`);
    writeFileSync(join(lockDir, "owner"), "1 someone-else");
    expect(a.save({ version: 1, panes: {}, tabs: {} })).toBe(false);
  });

  test("a single-pane tab whose name was taken is named once the name is free", async () => {
    const herdr = new FakeHerdr(
      snapshot([amp("w1:p1", "w1:t1", "Meta hooks race"), amp("w1:p2", "w1:t2", "Meta hooks race")], [tab("w1:t1", "1"), tab("w1:t2", "2")]),
    );
    const jev = new FakeJev(firstOption);
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.tabs.map((t) => t.label)).toEqual(["Meta hooks race", "2"]);
    herdr.snap.tabs[0]!.label = "mine"; // the user renames the first tab
    await sweep(deps(herdr, jev), { dryRun: false });
    expect(herdr.snap.tabs[1]!.label).toBe("Meta hooks race");
  });

  test("a pane someone else renamed no longer feeds its old topic to the tab", async () => {
    const herdr = new FakeHerdr(snapshot([amp("w1:p1", "w1:t1", "Meta hooks race"), amp("w1:p2", "w1:t1", "Login redirect")], [tab("w1:t1", "1", 2)]));
    const jev = new FakeJev(firstOption);
    await sweep(deps(herdr, jev), { dryRun: false });
    herdr.snap.panes[0]!.label = "scratch";
    jev.calls = [];
    await sweep(deps(herdr, jev), { dryRun: false });
    const tabCall = jev.calls.find((c) => "label" in c.questions);
    if (tabCall) expect(JSON.stringify(tabCall.state)).not.toContain("Meta hooks race");
  });
});

describe("naming quality", () => {
  test("request phrases skip fillers, contractions and path pieces", () => {
    expect(keyphrases("why doesn't the websocket reconnect after the laptop sleeps? I'm seeing it drop")).toEqual(
      expect.arrayContaining(["websocket reconnect", "laptop sleeps"]),
    );
    const k = keyphrases("why doesn't the websocket reconnect after the laptop sleeps? I'm seeing it drop");
    expect(k.some((p) => /'|’/.test(p))).toBe(false);
    const k2 = keyphrases("add retry with exponential backoff to the fetch client in src/api/client.ts");
    expect(k2).toContain("client.ts");
    expect(k2.some((p) => /\bsrc\b|\bapi client\b/.test(p))).toBe(false);
    expect(keyphrases("refactor auth middleware to use the new session store").some((p) => p.startsWith("refactor"))).toBe(false);
  });

  test("an agent name never repeats the task verb", () => {
    const req = paneRequest(ctx({ agent: "pi", branch: "claude/fix-websocket-reconnect-Xb12z", lastPrompt: "go ahead" }), "proj")!;
    const options = Object.keys((req.questions.subject as any).criteria);
    expect(options).toContain("websocket reconnect");
    const d = decidePane(req, result({ task: { fix: 0.9, debug: 0.1 }, subject: { "websocket reconnect": 0.8, proj: 0.2 } }), {}, "proj", opts);
    expect(d.name).toBe("fix websocket reconnect");
    expect(branchTopic("codex/add-pagination-to-users-endpoint")).toBe("pagination to users endpoint");
  });

  test("a project named like a task verb keeps the task", () => {
    const req = paneRequest(ctx({ agent: "pi", project: "test", lastPrompt: "sync the github fork" }), "pi-meta-oauth")!;
    const d = decidePane(req, result({ task: { ship: 0.4, setup: 0.3, fix: 0.3 }, subject: { test: 0.42, sync: 0.3, github: 0.28 } }), {}, "pi-meta-oauth", opts);
    expect(d.name).toBe("ship test");
  });

  test("an agent with nothing but the workspace's project is named by its task alone, without a subject question", () => {
    const req = paneRequest(ctx({ agent: "pi", project: "bounty", firstPrompt: "how does this codebase look" }), "bounty")!;
    expect(req.questions.subject).toBeUndefined();
    const d = decidePane(req, result({ task: { explore: 0.9, chat: 0.1 } }), {}, "bounty", opts);
    expect(d.name).toBe("explore");
  });

  test("terminal titles that repeat the command are not offered", () => {
    expect(echoesCommand("npm run dev", ["npm", "run", "dev"])).toBe(true);
    expect(echoesCommand("NVIM", ["nvim", "src/main.rs"])).toBe(true);
    const req = paneRequest(ctx({ command: ["npm", "run", "dev"], titlePhrases: ["npm run dev"] }), "proj")!;
    expect(Object.keys((req.questions.subject as any).criteria)).not.toContain("npm run dev");
    expect(titlePhrases("main.rs (~/dev/engine/src) - NVIM", {})).toContain("main.rs");
  });

  test("a plain shell with a leftover title is not named", () => {
    expect(paneRequest(ctx({ titlePhrases: ["htop"] }), "proj")).toBeNull();
  });

  test("tab options keep the separator in pane names", () => {
    const req = tabRequest(
      [
        { name: "server · web", agent: null, doing: "server", subject: "web", project: "proj", branch: null, title: null },
        { name: "tests", agent: null, doing: "tests", subject: null, project: "proj", branch: null, title: null },
      ],
      "proj",
      [],
    )!;
    expect(req.options).toContain("server · web");
  });

  test("command targets skip subcommands and flag values", () => {
    const t = (argv: string) => commandTarget(argv.split(" "))?.text ?? null;
    expect(t("docker run -p 8080:80 nginx")).toBe("nginx");
    expect(t("docker run --rm -it -v /Users/j/dev/webapp:/app node:20 bash")).toBe("node");
    expect(t("docker compose logs -f api")).toBe("api");
    expect(t("docker compose up")).toBeNull();
    expect(t("kubectl logs -f deploy/api -n prod")).toBe("api");
    expect(t("cargo watch -x test")).toBeNull();
    expect(t("cargo run --bin api")).toBe("api");
    expect(t("go test ./internal/auth/...")).toBe("auth");
    expect(t("deno task dev")).toBe("dev");
    expect(t("yarn workspace @acme/web dev")).toBe("web");
    expect(t("make -C build test")).toBe("test");
    expect(t("tail -n 100 -f /var/log/nginx/error.log")).toBe("error.log");
  });

  test("interrupt markers and bare slash commands are not requests", () => {
    const line = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    expect(userRequest(line("[Request interrupted by user]"))).toBeNull();
    expect(userRequest(line("[Request interrupted by user for tool use]"))).toBeNull();
    expect(userRequest(line("/clear"))).toBeNull();
    expect(userRequest(line("/clef on"))).toBeNull();
    expect(userRequest(line("/review please look at the auth changes and the session store"))).not.toBeNull();
  });
});

describe("privacy", () => {
  // Built at runtime so the fixtures do not look like real secrets to scanners.
  const pw = "Hunter2" + "Secret9";

  test("passwords in URLs and secret query parameters", () => {
    for (const url of [`postgres://app:${pw}@prod-db/app`, `mongodb+srv://u:${pw}@cluster0.x.net`, `redis://default:${pw}@cache:6379`, `https://alice:${pw}@api.example.com`]) {
      expect(redact(url)).not.toContain(pw);
    }
    expect(redact(`https://x.blob.core.windows.net/c?sv=1&sig=${pw}`)).not.toContain(pw);
  });

  test(".env, JSON and header shapes", () => {
    const env = [`SMTP_PASS=${pw}`, `ENCRYPTION_KEY=${pw}`, `SENTRY_DSN=https://${pw}@o1.ingest.sentry.io/1`, `DATABASE_URL=postgres://u:${pw}@h/db`, `{"password": "${pw}"}`, `"client_secret": "${pw}"`, `Authorization: Token ${pw}`, `Cookie: session=${pw}`].join("\n");
    expect(redact(env)).not.toContain(pw);
  });

  test("secrets passed as separate command-line arguments", () => {
    const cases = [`some-cli --password ${pw}`, `sshpass -p ${pw} ssh u@h`, `mysql -uroot -p${pw} db`, `redis-cli -a ${pw}`, `curl -u admin:${pw} https://x`, `deploy --token ${pw}`];
    for (const c of cases) expect(redactArgv(c.split(" ")).join(" ")).not.toContain(pw);
    expect(redactArgv(["ssh", "-p", "22", "u@h"])).toEqual(["ssh", "-p", "22", "u@h"]);
  });

  test("a private key body whose BEGIN line scrolled away", () => {
    const line = () => Array.from({ length: 64 }, (_, i) => "Ab3+/"[i % 5]).join("");
    const body = Array.from({ length: 50 }, line).join("\n") + "\n-----END RSA PRIVATE KEY-----";
    expect(redact(cleanOutput(body, 40, 3500))).not.toContain(line());
  });

  test("a secret never becomes a candidate name", () => {
    const req = paneRequest(ctx({ command: ["mysql", "-u", "root", `-p${pw}`, "mydb"], titlePhrases: [`deploy DB_PASS=${pw}`] }), "proj");
    expect(JSON.stringify(req)).not.toContain(pw);
  });
});
