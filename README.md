# herdr-jev-names

A [herdr](https://herdr.dev) plugin that names panes and tabs after what they
are doing. It reads each pane's context and lets TypeSafe's
[Jev](https://docs.typesafe.ai) classifier choose the name.

Examples of the kind of names it produces (actual picks depend on Jev):

| Pane | Name |
| --- | --- |
| amp, title `Meta hooks race - amp - ~/dev/app` | `Meta hooks race` |
| pi, asked "add retries to src/api/client.ts" | `build client.ts` |
| `bun run dev` in `packages/web` | `server · web` |
| `bun test --watch` | `tests` |
| `nvim src/main.rs` | `edit · main.rs` |
| `ssh ubuntu@prod-1` | `ssh · prod-1` |
| shell left behind by an Amp orb | the Amp thread's title |
| fresh zsh prompt | (unchanged) |

A tab with one pane takes that pane's name. For a tab with several panes, Jev
picks the label that best sums them up and differs from the other tabs.

## How names are made

Jev is a classifier, so it can't write text. It can only choose from options
it is given. For each pane the plugin:

1. Collects context: the agent and its status, the terminal title, the
   foreground command, folder, git branch, the agent's first and latest
   request (pi, Claude Code and Codex transcripts), and the last 40 lines of
   output (for agents, of what is on screen).
2. Builds options from that context: task titles that agents write (amp,
   Claude Code), phrases and file names from your recent requests and the
   agent's latest reply, the files the agent edited or read (from its tool
   calls), the command's target (edited file, ssh host, npm script),
   subfolder, branch and project. For agents without a transcript (muse),
   your messages and its replies are read off its screen.
3. Asks Jev two questions in one request:
   - What is the pane doing? For agents: fix, debug, build, refactor,
     review, test, docs, explore, plan, setup, ship, research or chat. For
     terminals: server, tests, build, logs, git, edit, repl, db, docker, ssh,
     monitor, deps, run or shell.
   - Which option names what it is about?
4. Puts the answers together: an agent's own title as-is, otherwise
   `<task> <topic>` for agents and `<activity> · <topic>` for terminals.
   Topics that repeat the workspace name or the activity are dropped.

A shell at its prompt keeps the name it had. If its agent exited before it
was named, it is named after that agent's session: from the transcript the
plugin remembered while the agent ran, or from the resume hint the agent
printed on exit (an Amp thread link, `claude --resume`, `codex resume`). For
Amp threads the title comes from `amp threads list`. A placeholder label such
as `new orb` is cleared when its agent has exited and there is nothing to name
the shell after.

A specific name sticks. A bare one such as `git` or `explore` doesn't
replace `fix clef` during the same agent session, and a quick command in
the shell doesn't either; a command that keeps running for 30 seconds does.
An agent whose requests can be read isn't named until you've asked it
something.

A name changes only if Jev gives its pick a probability of at least 0.3, and
the new pick has to beat the current one by 0.15. This keeps names from
flickering.

## Names you set are kept

The plugin only renames panes and tabs it named itself, panes with no name,
and tabs with herdr's numeric default names. If you rename one, or clear a
name the plugin set, it stops touching that pane or tab. Run **Jev: name this
pane and tab** to hand it back.

Labels in `JEV_NAMES_PLACEHOLDERS` (default: `new orb`, from the Amp Orbs
plugin) can be replaced.

## When it runs

- On server start.
- When an agent is detected or changes state (working, idle, done), so agent
  panes follow their current task.
- When panes or tabs are created, moved or closed.
- When focus changes (at most every 8 seconds). This catches commands started
  in plain shells, which raise no other events.

Each run checks every pane but only calls Jev for panes whose title, command,
folder, branch or agent requests changed since the last call. Concurrent hooks
take turns through a lock; events that arrive during a run are queued.

## Install

Requirements: herdr 0.9.3+, [bun](https://bun.sh), and a TypeSafe API key.

1. Install the plugin, disable it until it's configured, and create its config file:

   ```bash
   herdr plugin install BlockedPath/herdr-jev-names
   herdr plugin disable blockedpath.jev-names
   root="$(herdr plugin list --plugin blockedpath.jev-names --json | jq -r '.result.plugins[0].plugin_root')"
   cfg="$(herdr plugin config-dir blockedpath.jev-names)"
   cp "$root/config.env.example" "$cfg/config.env" && chmod 600 "$cfg/config.env"
   ```

   From a local checkout, use `herdr plugin link /path/to/herdr-jev-names --disabled`
   instead of the first two commands.

2. Set `TYPESAFE_API_KEY` in that `config.env`.

3. Preview the names for your current session. This renames nothing:

   ```bash
   cd "$root" && TYPESAFE_API_KEY=... bun src/main.ts dry-run
   ```

   Each line is one decision. Look for `"action":"error"` lines; they mean
   Jev or herdr rejected a request.

4. Enable the plugin and name everything once. Startup hooks don't run on
   enable.

   ```bash
   herdr plugin enable blockedpath.jev-names
   herdr plugin action invoke blockedpath.jev-names.name-all
   ```

Optional keybindings in `~/.config/herdr/config.toml` (neither key is bound
by default):

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "blockedpath.jev-names.name-all"
description = "jev: name all panes and tabs"

[[keys.command]]
key = "prefix+shift+m"
type = "plugin_action"
command = "blockedpath.jev-names.name-here"
description = "jev: name this pane and tab"
```

Then run `herdr server reload-config`.

## Actions

| Action | What it does |
| --- | --- |
| `name-all` | Decide every pane and tab again. Names you set are kept. |
| `name-here` | Name the focused pane and its tab, even if someone else named them. |
| `explain` | Show Jev's choices and probabilities for the focused pane and tab, without renaming. |

## Configuration

All settings are in [config.env.example](config.env.example). Environment
variables with the same names take precedence.

To preview without renaming anything:

```bash
TYPESAFE_API_KEY=... bun src/main.ts dry-run
```

This prints one JSON line per decision. Set `JEV_NAMES_DRY_RUN=1` in
`config.env` to make the hooks log to `decisions.jsonl` without renaming.
Since nothing is saved in that mode, each agent event asks Jev again.

## Privacy

Context is sent to TypeSafe's API, or the endpoint in `JEV_BASE_URL`. That
context is the terminal title, foreground command, folder, git branch and,
unless turned off, the last 40 lines of output and the agent's first and
latest request. Common secret formats are replaced with `[redacted]` before
sending: API keys and tokens, `password=` and `"password":` style values,
`*_KEY=` and `*_PASS=` style environment variables, passwords in URLs, secret
query parameters, `Authorization` and `Cookie` headers, values after flags
such as `--token` or `-p` (mysql, sshpass), JWTs and private keys. Redaction
is pattern-based, so it can miss unusual formats. A redacted value never
becomes a pane name. Set `JEV_NAMES_SEND_OUTPUT=0` or `JEV_NAMES_SEND_PROMPTS=0` to send less.

## Troubleshooting

Decisions are logged to `decisions.jsonl` in the plugin state dir
(`~/.local/state/herdr/plugins/blockedpath.jev-names/`). Hook output is in
`herdr plugin log list --plugin blockedpath.jev-names`.

## Development

```bash
bun install      # dev dependencies: TypeScript and bun types only
bun test
bun run typecheck
```

The plugin itself has no runtime dependencies.
