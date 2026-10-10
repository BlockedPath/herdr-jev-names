/**
 * Jev is a classifier: it cannot write a name, only pick among options. Names are built here from
 * options Jev chose: what the pane is doing (a fixed list) and what it is about (options taken
 * from the pane's own title, command, prompts, project and branch).
 */
import type { PaneContext } from "./context";
import { branchTopic, displayPath, echoesCommand, redactArgv } from "./context";
import type { ChoiceAnswer, ClassifyResult, Question } from "./jev";
import { choiceAnswer } from "./jev";
import { basename, redact, sameText, tidy, truncate } from "./text";

export type SubjectKind = "title" | "request" | "reply" | "file" | "target" | "subdir" | "branch" | "project" | "none";

export interface Subject {
  text: string;
  kind: SubjectKind;
  why: string;
}

/** What a coding agent is doing. Keys are shown in names, e.g. "fix login redirect". */
export const TASKS: Record<string, string> = {
  fix: "Fixing a bug, an error, a failing test or broken behavior",
  debug: "Investigating or diagnosing a problem whose cause is not known yet",
  build: "Implementing a new feature or building something new",
  refactor: "Restructuring, renaming, cleaning up or migrating existing code without changing behavior",
  review: "Reviewing code, a diff, a pull request or a design and reporting findings",
  test: "Writing, running or improving tests",
  docs: "Writing documentation, READMEs, comments or other prose",
  explore: "Reading and explaining a codebase, or answering questions about how it works",
  plan: "Planning, designing or comparing approaches before implementing",
  setup: "Configuring tools, environments, dependencies, CI or infrastructure",
  ship: "Committing, releasing, deploying or publishing",
  research: "Researching outside the codebase: web, docs, APIs, papers",
  chat: "General conversation that is not a software task",
};

/** What a plain terminal is used for. Keys are shown in names, e.g. "server · web". */
export const ACTIVITIES: Record<string, string> = {
  server: "Running a development or application server, such as vite, next dev, wrangler dev, rails s, uvicorn or a bun/node server",
  tests: "Running or watching tests, such as jest, vitest, pytest, cargo test, go test or bun test",
  build: "Compiling, bundling, type-checking or watching a build, such as tsc, cargo build, make or webpack",
  logs: "Following logs or a stream of events, such as tail -f, journalctl, docker logs or kubectl logs",
  git: "Working with git: status, diffs, commits, rebases, lazygit or tig",
  edit: "Editing files in a terminal editor such as vim, neovim, helix, emacs or nano",
  repl: "An interactive language shell or REPL, such as node, python, irb, iex or ghci",
  db: "A database client or queries, such as psql, mysql, sqlite3 or redis-cli",
  docker: "Managing containers or clusters, such as docker, docker compose, kubectl or k9s",
  ssh: "A shell on a remote machine over ssh or mosh",
  monitor: "Watching system resources, such as htop, btop, top or watch",
  deps: "Installing or updating dependencies with npm, bun, pnpm, pip, cargo or brew",
  run: "Running a one-off script, CLI tool or task",
  shell: "An idle prompt, or assorted commands with no single purpose",
};

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can " +
    "could did do does doing done down during each few for from further had has have having he her here hers him his how i if in into " +
    "is it its itself just let lets let's me more most my myself no nor not now of off on once only or other our ours out over own " +
    "please same she should so some such than that the their theirs them then there these they this those through to too under " +
    "until up very was we were what when where which while who whom why will with would you your yours yourself ok okay yes yeah " +
    "hey hi hello thanks thank sure maybe really actually basically still even way thing things stuff something anything everything " +
    "want need like make look see try get got use using used go going know think help tell show give take put keep work works " +
    "working check run new now one two first last next also via etc lot bit kind sort able currently right good bad well better " +
    "best much many every another code file files project repo codebase app great whats uses inside again seeing " +
    // Task verbs: the task question already says what kind of work it is.
    "add adds added create creates implement implements write writes update updates fix fixes fixed refactor remove delete " +
    "rename migrate build debug review explain investigate document set setup change changes improve support handle allow " +
    "ensure report command teach"
  ).split(/\s+/),
);

/** Verbs that, at the start of a subject, already say what the task is. */
const LEADING_VERBS = new Set([
  ...Object.keys(TASKS),
  "add", "create", "implement", "update", "remove", "delete", "rename", "migrate", "make", "write", "feat", "feature", "chore", "investigate", "improve",
]);

const FILE_RE = /(?:^|[\s"'`(\[])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|sh|zsh|bash|sql|md|mdx|json|jsonc|toml|ya?ml|css|scss|html|vue|svelte|astro|ex|exs|zig|nix|tf|proto|graphql|dockerfile))\b/gi;
const IDENT_RE = /\b([a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/** Candidate topics from free text: file names, identifiers and short runs of content words. */
export function keyphrases(text: string | null, limit = 5): string[] {
  if (!text) return [];
  const source = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .slice(0, 1500);
  const scored = new Map<string, { text: string; score: number; atomic: boolean }>();
  const add = (phrase: string, score: number, atomic = false) => {
    const key = phrase.toLowerCase();
    const hit = scored.get(key);
    if (hit) hit.score += score * 0.5;
    else scored.set(key, { text: phrase, score, atomic });
  };

  for (const m of source.matchAll(FILE_RE)) {
    if (!/(^|\/)(node_modules|dist|vendor|build)\//.test(m[1]!)) add(basename(m[1]!), 3, true);
  }
  for (const m of source.matchAll(IDENT_RE)) if (m[1]!.length >= 5) add(m[1]!, 2.5, true);

  // Paths, file names and quoted snippets only count through the rules above.
  const prose = source
    .replace(FILE_RE, " . ")
    .replace(/(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|`[^`\n]*`/gu, " . ")
    .replace(/\S*\/\S*/g, " . ");
  const sentences = prose.split(/[.!?;:\n()[\]{}"“”`,]+/);
  let position = 0;
  for (const sentence of sentences) {
    const words = sentence.split(/[^\p{L}\p{N}'’_+#-]+/u).filter(Boolean);
    let run: string[] = [];
    const flush = () => {
      for (let n = Math.min(3, run.length); n >= 1; n--) {
        for (let i = 0; i + n <= run.length; i++) {
          const phrase = run.slice(i, i + n).join(" ");
          if (n === 1 && (phrase.length < 4 || /^\d+$/.test(phrase))) continue;
          const lengthBonus = n === 2 ? 1.6 : n === 3 ? 1.3 : 1;
          add(phrase, lengthBonus * (1 / (1 + position / 40)));
        }
      }
      run = [];
    };
    for (const word of words) {
      position++;
      const lower = word.toLowerCase();
      // Contractions ("doesn't", "I'm") are filler.
      if (/['’]/.test(lower) || STOPWORDS.has(lower) || lower.length < 2 || /^[-#+_]+$/.test(lower)) flush();
      else run.push(word);
      if (run.length >= 4) flush();
    }
    flush();
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const kept: typeof ranked = [];
  for (const candidate of ranked) {
    const words = candidate.text.toLowerCase().split(" ");
    // A single word already inside a kept phrase adds nothing.
    if (!candidate.atomic && words.length === 1 && kept.some((k) => k.text.toLowerCase().split(" ").length > 1 && k.text.toLowerCase().split(" ").includes(words[0]!))) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept.map((k) => k.text);
}

const SSH_VALUE_FLAGS = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/** The host in `ssh [options] destination [command]`. */
export function sshDestination(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return args[i + 1]?.replace(/^.*@/, "") ?? null;
    if (a.startsWith("-")) {
      // `-p 22` takes the next argument; `-p22` and `-vA` do not.
      if (a.length === 2 && SSH_VALUE_FLAGS.has(a[1]!)) i++;
      continue;
    }
    return a.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "");
  }
  return null;
}

/** Flags that take a value as the next argument, per tool. */
const VALUE_FLAGS: Record<string, string[]> = {
  // `-f` is left out: it is `--file` before a compose subcommand but `--follow` after `logs`.
  docker: ["-p", "--publish", "-v", "--volume", "-e", "--env", "--env-file", "--name", "-w", "--workdir", "--network", "--entrypoint", "-u", "--user", "--file", "--platform", "-l", "--label", "--mount", "--project-name", "--profile", "-H", "--host", "--context"],
  // As for docker, `-f` is `--filename` for apply but `--follow` for logs.
  kubectl: ["-n", "--namespace", "--context", "-c", "--container", "-l", "--selector", "-o", "--output", "--filename", "--kubeconfig", "--since", "--tail", "--cluster"],
  cargo: ["-p", "--package", "--bin", "--example", "--test", "--bench", "-x", "--exec", "-s", "--shell", "--features", "-F", "--target", "-j", "--jobs", "--manifest-path", "-w", "--watch", "-i", "--ignore"],
  go: ["-run", "-tags", "-o", "-p", "-timeout", "-count", "-bench", "-C"],
  make: ["-C", "-f", "-j", "--directory", "--file", "-I"],
  node: ["--filter", "-F", "--workspace", "-w", "--cwd", "--prefix", "-C", "--dir"],
  tail: ["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"],
  deno: ["--config", "-c", "--import-map", "--allow-read", "--allow-write", "--allow-net", "--allow-env"],
};

const SUBCOMMANDS = new Set(["run", "exec", "x", "dlx", "task", "watch", "test", "build", "compose", "up", "down", "logs", "log", "get", "describe", "start", "restart", "attach", "port-forward", "apply", "delete", "edit", "top", "rollout", "status", "tool", "workspace", "serve"]);

/** Positional arguments, skipping flags and the values of `valueFlags`. */
function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (!a.includes("=") && valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(args: string[], flags: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const f of flags) {
      if (a === f && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1]!;
      if (a.startsWith(f + "=")) return a.slice(f.length + 1);
    }
  }
  return null;
}

/** Last meaningful path segment: `./internal/auth/...` -> `auth`, `@acme/web` -> `web`. */
function lastSegment(value: string): string | null {
  const parts = value.split(/[/:]/).filter((p) => p && p !== "." && p !== ".." && p !== "...");
  const last = parts[parts.length - 1];
  return last && /[\p{L}]/u.test(last) ? last : null;
}

/** Image or service base name: `ghcr.io/acme/api:latest` -> `api`. */
function imageName(value: string): string | null {
  return lastSegment(value.replace(/[:@][\w.-]*$/, ""));
}

/** A meaningful target in a command line: the edited file, ssh host, npm script, log file. */
export function commandTarget(argv: string[] | null): { text: string; why: string } | null {
  if (!argv?.length) return null;
  const [cmd, ...rest] = argv;
  const name = basename(cmd!);
  const result = (text: string | null | undefined, why: string) => (text ? { text, why } : null);

  if (/^(n?vim?|nvim|hx|helix|emacs(client)?|nano|micro|kak|code|subl)$/.test(name)) {
    const files = positionals(rest);
    return result(files.length ? basename(files[files.length - 1]!) : null, "File open in the editor");
  }
  if (/^(ssh|mosh|et)$/.test(name)) return result(sshDestination(rest), "Remote host of the ssh session");
  if (/^(npm|pnpm|yarn|bun)$/.test(name)) {
    const workspace = flagValue(rest, ["--filter", "-F", "--workspace", "-w"]);
    const pos = positionals(rest, VALUE_FLAGS.node);
    if (pos[0] === "workspace" && pos[1]) return result(lastSegment(pos[1]), "Package in the monorepo");
    if (workspace) return result(lastSegment(workspace), "Package in the monorepo");
    const script = pos[0] === "run" || pos[0] === "x" || pos[0] === "exec" || pos[0] === "dlx" ? pos[1] : pos[0];
    if (script && !/^(install|i|add|ci|remove|rm|update|upgrade|link|outdated|audit)$/.test(script)) return result(basename(script), "Package script being run");
    return null;
  }
  if (/^(make|just|task)$/.test(name)) {
    const target = positionals(rest, VALUE_FLAGS.make)[0];
    return result(target, "Make or just target being run");
  }
  if (/^(cargo|go|deno|uv|mise|poetry|pipenv|rye)$/.test(name)) {
    const named = name === "cargo" ? flagValue(rest, ["--bin", "-p", "--package", "--example"]) : null;
    if (named) return result(named, "Crate or binary being run");
    const pos = positionals(rest, [...(VALUE_FLAGS[name] ?? []), ...VALUE_FLAGS.cargo!]);
    while (pos.length && SUBCOMMANDS.has(pos[0]!)) pos.shift();
    return result(pos[0] ? lastSegment(pos[0]) : null, "Task, package or module being run");
  }
  if (/^(tail|less|bat|cat|more|lnav)$/.test(name)) {
    const files = positionals(rest, VALUE_FLAGS.tail);
    return result(files.length ? basename(files[files.length - 1]!) : null, "File being followed or read");
  }
  if (/^(docker|podman|nerdctl)$/.test(name)) {
    const pos = positionals(rest, VALUE_FLAGS.docker).filter((a) => !/\.ya?ml$/.test(a));
    while (pos.length && SUBCOMMANDS.has(pos[0]!)) pos.shift();
    return result(pos[0] ? imageName(pos[0]) : null, "Container image or service");
  }
  if (/^(kubectl|kubecolor|oc)$/.test(name)) {
    const pos = positionals(rest, VALUE_FLAGS.kubectl).filter((a) => !/\.ya?ml$/.test(a));
    while (pos.length && SUBCOMMANDS.has(pos[0]!)) pos.shift();
    return result(pos[0] ? lastSegment(pos[0]) : null, "Kubernetes resource");
  }
  const script = positionals(rest).find((a) => /\.(?:py|rb|js|ts|sh|mjs|cjs|pl|php|lua)$/.test(a));
  return result(script ? basename(script) : null, "Script being run");
}

/** Options for "what is this pane about", most specific first, de-duplicated. */
export function subjectOptions(ctx: PaneContext, workspaceLabel: string | null): Subject[] {
  const out: Subject[] = [];
  const add = (text: string | null | undefined, kind: SubjectKind, why: string) => {
    if (!text) return;
    const clean = tidy(text).replace(/^["'`]+|["'`]+$/g, "");
    if (Array.from(clean).length < 2 || Array.from(clean).length > 60) return;
    // A redacted value must never become a label.
    if (/\[redacted\]/i.test(clean) || redact(clean) !== clean) return;
    if (out.some((s) => sameText(s.text, clean))) return;
    out.push({ text: clean, kind, why });
  };

  for (const t of ctx.titlePhrases) {
    // Shells often set the title to the running command line; the command target says it better.
    if (!ctx.agent && ctx.command && echoesCommand(t, ctx.command)) continue;
    add(t, "title", ctx.agent ? "The agent's own title for its current task" : "The terminal title");
  }
  const target = commandTarget(ctx.command);
  if (target) add(target.text, "target", target.why);
  if (ctx.agent) {
    const before = out.length;
    for (const p of keyphrases(ctx.lastPrompt, 6)) add(p, "request", "Phrase from the user's latest request to the agent");
    for (const p of keyphrases(ctx.earlierPrompts.join(". "), 4)) add(p, "request", "Phrase from one of the user's recent requests to the agent");
    if (ctx.firstPrompt !== ctx.lastPrompt) for (const p of keyphrases(ctx.firstPrompt, 4)) add(p, "request", "Phrase from the user's first request to the agent");
    // Follow-ups such as "try again" name no topic; the agent's reply usually does.
    if (out.length - before < 3) for (const p of keyphrases(ctx.lastReply, 4)) add(p, "reply", "Phrase from the agent's latest reply");
  }
  if (ctx.subdir) {
    add(basename(ctx.subdir), "subdir", `Folder inside the project: ${ctx.subdir}`);
  }
  add(branchTopic(ctx.branch), "branch", `Git branch ${ctx.branch}`);
  add(ctx.project, "project", sameText(ctx.project, workspaceLabel) ? "Project folder; the workspace already has this name" : "Project folder");
  if (!ctx.agent) add("nothing specific", "none", "Nothing more specific than the activity itself");
  return out.slice(0, 60);
}

export interface PaneRequest {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  subjects: Subject[];
  kind: "agent" | "terminal";
}

/** The Jev request for a pane, or null when there is nothing to name (an idle shell). */
export function paneRequest(ctx: PaneContext, workspaceLabel: string | null): PaneRequest | null {
  // A plain shell with nothing running: any title is left over from an earlier command.
  if (!ctx.agent && !ctx.command) return null;
  const subjects = subjectOptions(ctx, workspaceLabel);
  if (!subjects.length) return null;

  const pane: Record<string, unknown> = {
    working_directory: ctx.cwd ? displayPath(ctx.cwd) : null,
    project: ctx.project,
    git_branch: ctx.branch,
    terminal_title: ctx.rawTitle,
  };
  if (ctx.agent) {
    pane.agent = ctx.agent;
    pane.agent_status = ctx.agentStatus;
    if (ctx.firstPrompt) pane.first_request = ctx.firstPrompt;
    if (ctx.lastPrompt && ctx.lastPrompt !== ctx.firstPrompt) pane.latest_request = ctx.lastPrompt;
    if (ctx.earlierPrompts.length) pane.earlier_requests = ctx.earlierPrompts;
    if (ctx.lastReply) pane.latest_reply = ctx.lastReply;
  } else {
    pane.foreground_command = ctx.command ? redactArgv(ctx.command).join(" ") : null;
  }
  if (ctx.output) pane.recent_output = ctx.output;

  const criteria: Record<string, string> = {};
  for (const s of subjects) criteria[s.text] = s.why;

  const questions: Record<string, Question> = {};
  // With a single option there is nothing to ask; decidePane takes it as given.
  if (subjects.length > 1) questions.subject = {
      type: "choice",
      instructions: ctx.agent
        ? "Which option best names the specific thing the coding agent in `pane` is working on right now, so the user can recognize this pane at a glance among others? Prefer the most specific option that `pane.latest_request`, `pane.earlier_requests`, `pane.first_request`, `pane.latest_reply` or `pane.terminal_title` supports; choose the project only when nothing more specific fits."
        : "Which option best names what the terminal in `pane` is focused on right now, so the user can recognize it at a glance among other panes? Judge from `pane.foreground_command`, `pane.terminal_title` and `pane.recent_output`. Choose `nothing specific` when no option adds information beyond the activity.",
      criteria,
    };
  if (ctx.agent) {
    questions.task = {
      type: "choice",
      instructions: "What kind of work is the coding agent in `pane` doing for the user right now? Judge mainly from `pane.latest_request` and `pane.earlier_requests`, then `pane.latest_reply`, `pane.first_request` and `pane.terminal_title`.",
      criteria: TASKS,
    };
  } else {
    questions.activity = {
      type: "choice",
      instructions: "What is the terminal in `pane` being used for right now? Judge from `pane.foreground_command` first, then `pane.terminal_title` and `pane.recent_output`.",
      criteria: ACTIVITIES,
    };
  }
  return { state: { pane }, questions, subjects, kind: ctx.agent ? "agent" : "terminal" };
}

export interface Previous {
  auto?: string | null;
  what?: string | null;
  subject?: string | null;
}

export interface Pick {
  value: string;
  probability: number;
  kept: boolean;
}

/** The top choice, unless the previous one is still within `hysteresis` of it. */
export function pickWithHysteresis(answer: ChoiceAnswer, previous: string | null | undefined, hysteresis: number): Pick {
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const [top, topP] = ranked[0] ?? [answer.choice, answer.confidence];
  if (previous && previous !== top && previous in answer.probabilities) {
    const prevP = answer.probabilities[previous]!;
    if (topP - prevP < hysteresis) return { value: previous, probability: prevP, kept: true };
  }
  return { value: top, probability: topP, kept: false };
}

export interface PaneDecision {
  name: string | null;
  what: string | null;
  subject: Subject | null;
  /** The subject text when it is part of the name; tabs reuse it. */
  topic: string | null;
  confident: boolean;
  detail: { what?: Pick; subject?: Pick };
}

export interface NamingOptions {
  separator: string;
  maxLength: number;
  minProbability: number;
  hysteresis: number;
}

/** Subjects that only repeat the activity, e.g. "tests · test" or "server · dev". */
const ACTIVITY_ECHOES: Record<string, string[]> = {
  server: ["dev", "serve", "server", "start", "preview", "watch"],
  tests: ["test", "tests", "spec", "check", "test:watch", "test watch"],
  build: ["build", "watch", "compile", "tsc", "typecheck", "check"],
  logs: ["log", "logs"],
  deps: ["install", "i", "add", "update", "upgrade"],
  git: ["git"],
  docker: ["docker", "compose", "docker compose"],
};

function echoesActivity(subject: string, activity: string): boolean {
  const s = subject.toLowerCase();
  return s === activity || (ACTIVITY_ECHOES[activity]?.includes(s) ?? false);
}

export function decidePane(request: PaneRequest, result: ClassifyResult, previous: Previous, workspaceLabel: string | null, opts: NamingOptions): PaneDecision {
  const whatAnswer = choiceAnswer(result, request.kind === "agent" ? "task" : "activity");
  const only = request.subjects.length === 1 ? request.subjects[0]!.text : null;
  const subjectAnswer: ChoiceAnswer | null = only ? { type: "choice", choice: only, probabilities: { [only]: 1 }, confidence: 1 } : choiceAnswer(result, "subject");
  if (!whatAnswer || !subjectAnswer) return { name: null, what: null, subject: null, topic: null, confident: false, detail: {} };

  const what = pickWithHysteresis(whatAnswer, previous.what, opts.hysteresis);
  const subjectPick = pickWithHysteresis(subjectAnswer, previous.subject, opts.hysteresis);
  const subject = request.subjects.find((s) => s.text === subjectPick.value) ?? null;
  const confident = what.probability >= opts.minProbability && subjectPick.probability >= opts.minProbability;
  const detail = { what, subject: subjectPick };
  if (!subject) return { name: null, what: what.value, subject: null, topic: null, confident: false, detail };

  let name: string | null;
  let topic: string | null = subject.text;
  if (request.kind === "agent") {
    const firstWord = subject.text.split(/\s+/)[0]!.toLowerCase();
    if (subject.kind === "title") name = subject.text;
    else if (subject.kind === "project" && sameText(subject.text, workspaceLabel)) {
      // The workspace already shows the project.
      name = what.value;
      topic = null;
    } else if (LEADING_VERBS.has(firstWord) && /\s/.test(subject.text) && (subject.kind === "request" || subject.kind === "reply" || subject.kind === "branch")) {
      // A phrase like "fix websocket reconnect" already says what the task is. Folder and file
      // names are left alone: a project called "test" is not a verb.
      name = /^[A-Z][a-z]/.test(subject.text) ? subject.text[0]!.toLowerCase() + subject.text.slice(1) : subject.text;
    } else name = `${what.value} ${subject.text}`;
  } else if (what.value === "shell") {
    name = subject.kind === "title" || subject.kind === "target" ? subject.text : null;
  } else {
    const redundant =
      subject.kind === "none" || (subject.kind === "project" && sameText(subject.text, workspaceLabel)) || echoesActivity(subject.text, what.value);
    name = redundant ? what.value : `${what.value}${opts.separator}${subject.text}`;
    if (redundant) topic = null;
  }
  if (!name) topic = null;
  return { name: name ? truncate(name, opts.maxLength) : null, what: what.value, subject, topic, confident, detail };
}

// ---------------------------------------------------------------------------------------------
// Tabs

export interface TabPaneSummary {
  name: string | null;
  agent: string | null;
  doing: string | null;
  subject: string | null;
  project: string | null;
  branch: string | null;
  title: string | null;
}

export interface TabRequest {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  options: string[];
}

export function tabOptions(panes: TabPaneSummary[], workspaceLabel: string | null): Array<{ text: string; why: string }> {
  const out: Array<{ text: string; why: string }> = [];
  const add = (text: string | null | undefined, why: string) => {
    if (!text) return;
    // Names come from this plugin or a user; only whitespace needs tidying.
    const clean = text.replace(/\s+/g, " ").trim();
    if (Array.from(clean).length < 2 || out.some((o) => sameText(o.text, clean))) return;
    out.push({ text: clean, why });
  };
  for (const p of panes) add(p.name, "Name of one of the tab's panes");
  for (const p of panes) if (p.subject && !sameText(p.subject, workspaceLabel)) add(p.subject, "What one of the tab's panes is about");
  for (const p of panes) if (!sameText(p.project, workspaceLabel)) add(p.project, "Project folder of panes in the tab");
  for (const p of panes) add(branchTopic(p.branch), "Git branch of panes in the tab");
  return out.slice(0, 60);
}

export function tabRequest(panes: TabPaneSummary[], workspaceLabel: string | null, otherTabs: string[]): TabRequest | null {
  const options = tabOptions(panes, workspaceLabel);
  if (options.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.text] = o.why;
  return {
    state: {
      tab: {
        workspace: workspaceLabel,
        other_tabs: otherTabs,
        panes: panes.map((p) => ({ name: p.name, agent: p.agent, doing: p.doing, about: p.subject, project: p.project, title: p.title })),
      },
    },
    questions: {
      label: {
        type: "choice",
        instructions:
          "Which option is the best short name for the tab described in `tab`? A good tab name says what the tab's panes are being used for together, so the user can find it among `tab.other_tabs`. Prefer the work that the agents in `tab.panes` are doing over supporting terminals.",
        criteria,
      },
    },
    options: options.map((o) => o.text),
  };
}

/** The tab name: Jev's choice, avoiding names other tabs in the workspace already use. */
export function decideTab(answer: ChoiceAnswer, previous: string | null | undefined, otherTabs: string[], opts: NamingOptions): { name: string | null; pick: Pick; confident: boolean } {
  let pick = pickWithHysteresis(answer, previous, opts.hysteresis);
  const taken = (name: string) => otherTabs.some((t) => sameText(t, name));
  if (taken(pick.value)) {
    const alternative = Object.entries(answer.probabilities)
      .sort((a, b) => b[1] - a[1])
      .find(([name, p]) => !taken(name) && p >= opts.minProbability / 2);
    if (alternative) pick = { value: alternative[0], probability: alternative[1], kept: false };
  }
  let name = truncate(pick.value, opts.maxLength);
  for (let n = 2; taken(name) && n < 10; n++) name = `${truncate(pick.value, opts.maxLength - 2)} ${n}`;
  return { name, pick, confident: pick.probability >= opts.minProbability };
}
