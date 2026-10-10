/** One pass over the session: decide and apply names for every pane, then every tab. */
import type { Config } from "./config";
import type { PaneContext } from "./context";
import { agentProgram, agentScreen, collectPane, HERDR_AGENTS, readSession, screenRequests, sessionFields } from "./context";
import type { Herdr, Snapshot, SnapshotPane } from "./herdr";
import type { Classifier } from "./jev";
import { choiceAnswer } from "./jev";
import type { PaneDecision, TabPaneSummary } from "./naming";
import { decidePane, decideTab, paneRequest, tabRequest } from "./naming";
import type { PaneEntry, State, Store, TabEntry } from "./state";
import { ownership } from "./state";
import { findLastAgent, resumeHint } from "./lastagent";
import { cleanOutput, digest, redact, sameText, stripAnsi, tidy, truncate } from "./text";

export interface SweepOptions {
  /** Panes and tabs to decide even if unchanged; with `unlock`, also those someone else named. */
  forcePanes?: Set<string>;
  forceTabs?: Set<string>;
  unlock?: boolean;
  /** Decide everything again, ignoring fingerprints (locks still apply). */
  reevaluate?: boolean;
  /** Pane id moves: old id -> new id. */
  moves?: Array<[string, string]>;
  dryRun: boolean;
  /** Restrict work to these panes and tabs (explain). */
  only?: { panes: Set<string>; tabs: Set<string> };
}

export interface Decision {
  kind: "pane" | "tab";
  id: string;
  from: string | null;
  to: string | null;
  action: "renamed" | "would-rename" | "cleared" | "kept" | "skipped" | "locked" | "error";
  reason: string;
  detail?: Record<string, unknown>;
}

export interface Deps {
  herdr: Herdr;
  jev: Classifier | null;
  store: Store;
  cfg: Config;
}

const LOCKED_REASON = "named by someone else; run name-here to hand it back";

const isDefaultTabLabel = (placeholders: string[]) => (label: string) => /^\d+$/.test(label.trim()) || placeholders.includes(label.trim().toLowerCase());
const isDefaultPaneLabel = (placeholders: string[]) => (label: string) => placeholders.includes(label.trim().toLowerCase());

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Bump when naming rules change, so every pane is decided again once. */
const FINGERPRINT_VERSION = 4;

/** How long a command must run before a bare activity name ("git", "run") may replace a specific one. */
const LONG_RUNNING_MS = 30_000;

function paneFingerprint(ctx: PaneContext, screen: string | null): string {
  return digest({
    v: FINGERPRINT_VERSION,
    screen,
    agent: ctx.agent,
    title: ctx.rawTitle,
    command: ctx.command,
    cwd: ctx.cwd,
    branch: ctx.branch,
    first: ctx.firstPrompt,
    last: ctx.lastPrompt,
    reply: ctx.lastReply,
    files: ctx.files.slice(0, 4),
  });
}

/** Identifies an agent session: the transcript path, or the agent alone when it has none. */
function sessionKey(agent: string, session: string | null | undefined): string {
  return `${agent}:${session ?? ""}`;
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 200);
}

/**
 * Moves state entries to the ids panes and tabs have now. Queued pane.moved events give the
 * mapping directly; otherwise an entry whose id is gone is matched to a live id by the label the
 * plugin gave it, which also covers moves whose event was handled late or dropped.
 */
function reconcile<E extends { auto?: string | null; pending?: string | null; locked?: boolean }>(
  entries: Record<string, E>,
  live: Array<{ id: string; label: string | null | undefined }>,
  moves: Array<[string, string]>,
): void {
  for (const [from, to] of moves) {
    if (from === to || !entries[from]) continue;
    entries[to] = { ...entries[to], ...entries[from] };
    delete entries[from];
  }
  const liveIds = new Set(live.map((l) => l.id));
  const orphans = Object.entries(entries).filter(([id, e]) => !liveIds.has(id) && !e.locked && (e.auto || e.pending));
  if (!orphans.length) return;
  for (const { id, label } of live) {
    const current = entries[id];
    if (!label || current?.auto || current?.pending || current?.locked) continue;
    const matches = orphans.filter(([, e]) => e.auto === label || e.pending === label);
    if (matches.length !== 1) continue;
    const [oldId, entry] = matches[0]!;
    if (!entries[oldId]) continue;
    entries[id] = { ...current, ...entry };
    delete entries[oldId];
  }
}

export async function sweep(deps: Deps, opts: SweepOptions): Promise<Decision[]> {
  const { herdr, jev, store, cfg } = deps;
  const snap: Snapshot = await herdr.snapshot();
  const state: State = store.load();
  const decisions: Decision[] = [];
  const naming = { separator: cfg.separator, minProbability: cfg.minProbability, hysteresis: cfg.hysteresis };
  const persist = () => {
    if (!opts.dryRun) store.save(state);
  };

  if (!opts.only) {
    reconcile(state.panes, snap.panes.map((p) => ({ id: p.pane_id, label: p.label })), opts.moves ?? []);
    reconcile(state.tabs, snap.tabs.map((t) => ({ id: t.tab_id, label: t.label })), []);
    const livePanes = new Set(snap.panes.map((p) => p.pane_id));
    const liveTabs = new Set(snap.tabs.map((t) => t.tab_id));
    for (const id of Object.keys(state.panes)) if (!livePanes.has(id)) delete state.panes[id];
    for (const id of Object.keys(state.tabs)) if (!liveTabs.has(id)) delete state.tabs[id];
  }

  const workspaceLabel = new Map(snap.workspaces.map((w) => [w.workspace_id, w.label]));
  const agentInfo = new Map(snap.agents.map((a) => [a.pane_id, a]));
  /** Label each pane has (or would have, in a dry run) after this pass. */
  const paneLabel = new Map<string, string | null>(snap.panes.map((p) => [p.pane_id, p.label ?? null]));
  const placeholders = cfg.placeholders;

  // ---- panes
  const panes = snap.panes.filter((p) => !opts.only || opts.only.panes.has(p.pane_id));
  if (cfg.panes) {
    await pool(panes, 4, async (pane: SnapshotPane) => {
      const id = pane.pane_id;
      const entry: PaneEntry = (state.panes[id] ??= {});
      const forced = opts.forcePanes?.has(id) ?? false;
      if (forced && opts.unlock) entry.locked = false;
      const own = forced && opts.unlock ? "free" : ownership(pane.label, entry, isDefaultPaneLabel(placeholders));
      const record = (d: Omit<Decision, "kind" | "id" | "from">) => decisions.push({ kind: "pane", id, from: pane.label ?? null, ...d });

      if (own === "foreign") {
        if (!entry.locked) record({ to: null, action: "locked", reason: LOCKED_REASON });
        // What the plugin knew about the pane no longer describes it.
        state.panes[id] = { locked: true, project: entry.project, branch: entry.branch };
        return;
      }

      /** Renames the pane, saving the intended name first so a crash can't orphan it. */
      const apply = async (name: string, chosen: Partial<PaneEntry>, fp: string, reason: string, detail?: Record<string, unknown>) => {
        if (name === (pane.label ?? "")) {
          Object.assign(entry, chosen, { auto: name, fp, at: Date.now() });
          if (forced) record({ to: name, action: "kept", reason: "already named this", detail });
          return;
        }
        if (opts.dryRun) {
          // Nothing is saved in a dry run; the entry only feeds this pass's tab decisions.
          paneLabel.set(id, name);
          Object.assign(entry, chosen);
          record({ to: name, action: "would-rename", reason: reason || "dry run", detail });
          return;
        }
        entry.pending = name;
        persist();
        try {
          await herdr.renamePane(id, name);
        } catch (error) {
          entry.pending = null;
          delete entry.fp;
          record({ to: name, action: "error", reason: errorText(error), detail });
          return;
        }
        paneLabel.set(id, name);
        Object.assign(entry, chosen, { auto: name, pending: null, fp, at: Date.now() });
        persist();
        record({ to: name, action: "renamed", reason, detail });
      };

      /** Asks Jev to name a pane from its context; null when it has no confident name. */
      const askJev = async (ctx: PaneContext, wsLabel: string | null): Promise<{ decision: PaneDecision; detail: Record<string, unknown> } | "error" | null> => {
        const request = paneRequest(ctx, wsLabel);
        if (!request || !jev) return null;
        try {
          const result = await jev.classify(request.state, request.questions);
          const decision = decidePane(request, result, { what: entry.what, subject: entry.subjectPick }, wsLabel, { ...naming, maxLength: cfg.maxPaneLength });
          return { decision, detail: { what: decision.detail.what, subject: decision.detail.subject, kind: decision.subject?.kind } };
        } catch (error) {
          record({ to: null, action: "error", reason: errorText(error) });
          return "error";
        }
      };

      const ctx = await collectPane(herdr, pane, agentInfo.get(id), { sendPrompts: cfg.sendPrompts });
      const program = ctx.agent ? null : agentProgram(ctx.command);
      if (program) {
        // An agent herdr detects runs for a moment before herdr reports it, and after it stops.
        // Naming it as a plain terminal then would replace its task name with a generic one; its
        // own events will name it. Agents herdr can't detect are named as agents.
        if (!forced && HERDR_AGENTS.has(program)) return;
        ctx.agent = program;
        ctx.command = null;
      }
      Object.assign(entry, { project: ctx.project, branch: ctx.branch, agent: ctx.agent, title: ctx.titlePhrases[0] ?? null });
      // When the current foreground command started, as far as the plugin has seen.
      // Keyed on the job (process group) so a script swapping children keeps one start time.
      const commandKey = ctx.command ? String(ctx.commandGroup ?? digest(ctx.command)) : null;
      if (!commandKey) entry.command = null;
      else if (entry.command?.key !== commandKey) entry.command = { key: commandKey, since: Date.now() };
      if (ctx.agent) {
        // Remembered so the pane can keep a name from this agent after it exits.
        const same = entry.lastAgent?.agent === ctx.agent ? entry.lastAgent : null;
        entry.lastAgent = { agent: ctx.agent, session: ctx.sessionFile ?? same?.session ?? null, title: ctx.titlePhrases[0] ?? same?.title ?? null };
      }
      // An agent without a transcript or title (muse) is known only by its screen, so the screen
      // is part of what decides whether it changed.
      const screenOnly = !!ctx.agent && !ctx.sessionFile && !ctx.titlePhrases.length && cfg.sendOutput;
      let rawOutput: string | null = screenOnly ? await herdr.read(id, 60) : null;
      if (screenOnly) {
        ctx.output = redact(cleanOutput(rawOutput!, 40, 3500));
        // Your messages on its screen stand in for a transcript; short replies ("no", "thanks")
        // say less about the task than the last real question.
        const asked = screenRequests(ctx.output).map((r) => (r.length > 400 ? r.slice(0, 400) + "…" : r));
        const substantive = asked.filter((r) => r.split(" ").length >= 3);
        ctx.lastPrompt = substantive.at(-1) ?? asked.at(-1) ?? null;
        ctx.earlierPrompts = asked.filter((r) => r !== ctx.lastPrompt).slice(-2).reverse();
      }
      const fp = paneFingerprint(ctx, screenOnly ? digest(agentScreen(ctx.output)) : null);
      if (!forced && !opts.reevaluate && entry.fp === fp) return;

      const idle = !ctx.agent && !ctx.command;
      rawOutput ??= cfg.sendOutput || idle ? await herdr.read(id, 60) : "";
      if (cfg.sendOutput) ctx.output = redact(cleanOutput(rawOutput, 40, 3500));
      const wsLabel = workspaceLabel.get(pane.workspace_id) ?? null;

      if (idle) {
        // A shell at its prompt keeps the name it has, unless that name is bare ("git") and the agent
        // that last ran there gives a more specific one. Without a name, it is named after that
        // agent; a placeholder label left by an exited agent is cleared.
        const rememberedKey = entry.lastAgent ? sessionKey(entry.lastAgent.agent, entry.lastAgent.session ?? entry.lastAgent.title) : null;
        if (entry.auto && (entry.subject || !entry.lastAgent || entry.lastAgentTried === rememberedKey)) {
          entry.fp = fp;
          return;
        }
        const last = await findLastAgent(entry.lastAgent, stripAnsi(rawOutput), ctx.cwd);
        const via = last ? `named after the last ${last.agent} session` : "";
        const lastKey = last ? sessionKey(last.agent, last.session ?? last.title) : null;
        if (rememberedKey) entry.lastAgentTried = rememberedKey;
        if (last?.title) {
          const title = tidy(last.title);
          if (redact(title) === title && !/\[redacted\]/i.test(title)) {
            await apply(truncate(title, cfg.maxPaneLength), { what: null, subject: title, subjectPick: null, namedBy: lastKey }, fp, via, { kind: "last-agent", agent: last.agent });
            return;
          }
        }
        if (last?.session && cfg.sendPrompts) {
          const session = readSession(last.session, entry.project && ctx.cwd ? ctx.cwd : null);
          if (session.first || session.last) {
            const agentCtx: PaneContext = { ...ctx, agent: last.agent, agentStatus: "exited", titlePhrases: [], rawTitle: null, promptsRead: true, ...sessionFields(session) };
            const asked = await askJev(agentCtx, wsLabel);
            if (asked === "error") return;
            // Replacing one bare name with another gains nothing.
            if (asked?.decision.name && asked.decision.confident && (!entry.auto || asked.decision.topic)) {
              const d = asked.decision;
              await apply(d.name!, { what: d.what, subject: d.topic, subjectPick: d.detail.subject?.value ?? null, namedBy: lastKey }, fp, via, asked.detail);
              return;
            }
          }
        }
        if (!entry.auto && pane.label && isDefaultPaneLabel(placeholders)(pane.label) && (entry.lastAgent || last || resumeHint(rawOutput))) {
          if (opts.dryRun) record({ to: null, action: "would-rename", reason: "would clear a placeholder left by an exited agent" });
          else {
            try {
              await herdr.clearPaneLabel(id);
              paneLabel.set(id, null);
              record({ to: null, action: "cleared", reason: "placeholder left by an exited agent" });
            } catch (error) {
              record({ to: null, action: "error", reason: errorText(error) });
              return;
            }
          }
        } else if (forced) record({ to: null, action: "skipped", reason: "idle shell: nothing to name yet" });
        entry.fp = fp;
        return;
      }

      if (!jev) {
        record({ to: null, action: "skipped", reason: "no Jev API key" });
        return;
      }
      const asked = await askJev(ctx, wsLabel);
      if (asked === "error") return;
      if (!asked) {
        entry.fp = fp;
        return;
      }
      const { decision, detail } = asked;
      if (!decision.name || !decision.confident) {
        entry.fp = fp;
        record({ to: decision.name, action: "kept", reason: decision.name ? "Jev was not confident enough" : "no useful name", detail });
        return;
      }
      // A bare name ("git", "explore") doesn't replace a specific one ("fix clef") the plugin gave,
      // unless a plain command has kept running: a quick `git status` shouldn't rename the pane.
      // For agents, only while it is the same session that gave the name: a new session or agent
      // starts fresh.
      const source = ctx.agent ? sessionKey(ctx.agent, ctx.sessionFile) : null;
      const specific = own === "ours" && !!entry.subject && pane.label === entry.auto && (!ctx.agent || entry.namedBy === source);
      if (!forced && specific && !decision.topic && decision.name !== pane.label) {
        const ranFor = entry.command ? Date.now() - entry.command.since : 0;
        if (ctx.agent || ranFor < LONG_RUNNING_MS) {
          // Without a fingerprint, the next event looks again: the command may still be running.
          if (ctx.agent) entry.fp = fp;
          record({ to: decision.name, action: "kept", reason: `keeps the more specific ${pane.label}`, detail });
          return;
        }
      }
      await apply(decision.name, { what: decision.what, subject: decision.topic, subjectPick: decision.detail.subject?.value ?? null, namedBy: source }, fp, "", detail);
    });
  }

  // ---- tabs
  if (cfg.tabs) {
    const tabLabel = new Map(snap.tabs.map((t) => [t.tab_id, t.label]));
    for (const tab of snap.tabs) {
      if (opts.only && !opts.only.tabs.has(tab.tab_id)) continue;
      const id = tab.tab_id;
      const entry: TabEntry = (state.tabs[id] ??= {});
      const forced = opts.forceTabs?.has(id) ?? false;
      if (forced && opts.unlock) entry.locked = false;
      let own = forced && opts.unlock ? "free" : ownership(tab.label, entry, isDefaultTabLabel(placeholders));
      // A number typed over a name the plugin gave is the user's choice, like clearing a pane label.
      if (own === "free" && entry.auto && /^\d+$/.test(tab.label.trim()) && tab.label.trim() !== entry.auto) own = "foreign";
      const record = (d: Omit<Decision, "kind" | "id" | "from">) => decisions.push({ kind: "tab", id, from: tab.label, ...d });
      if (own === "foreign") {
        if (!entry.locked) record({ to: null, action: "locked", reason: LOCKED_REASON });
        state.tabs[id] = { locked: true };
        continue;
      }

      const summaries: TabPaneSummary[] = snap.panes
        .filter((p) => p.tab_id === id)
        .map((p) => {
          const e = state.panes[p.pane_id] ?? {};
          const label = paneLabel.get(p.pane_id) ?? null;
          return {
            name: label && !isDefaultPaneLabel(placeholders)(label) ? label : null,
            agent: e.agent ?? p.agent ?? null,
            doing: e.what ?? null,
            subject: e.subject ?? null,
            project: e.project ?? null,
            branch: e.branch ?? null,
            title: e.title ?? null,
          };
        });
      const wsLabel = workspaceLabel.get(tab.workspace_id) ?? null;
      const fp = digest({ summaries, wsLabel });
      if (!forced && !opts.reevaluate && entry.fp === fp) continue;
      const others = snap.tabs.filter((t) => t.workspace_id === tab.workspace_id && t.tab_id !== id).map((t) => tabLabel.get(t.tab_id) ?? t.label);
      const taken = (name: string) => others.some((o) => sameText(o, name));

      let pick: string | null = null;
      let name: string | null = null;
      let detail: Record<string, unknown> | undefined;
      // A one-letter pane label (often a slip of the rename key) is no tab name.
      const lone = summaries.length === 1 && summaries[0]!.name && Array.from(summaries[0]!.name.trim()).length >= 2 ? summaries[0]!.name : null;
      const request = lone ? null : tabRequest(summaries, wsLabel, others);
      if (lone || request?.options.length === 1) {
        // One pane or one candidate: nothing for Jev to choose.
        pick = lone ?? request!.options[0]!;
        if (taken(truncate(pick, cfg.maxTabLength))) {
          // Leave the fingerprint unset so the tab is tried again once the name is free.
          record({ to: null, action: "kept", reason: `another tab is already called ${pick}` });
          continue;
        }
        name = truncate(pick, cfg.maxTabLength);
      } else if (!request) {
        name = null;
      } else if (!jev) {
        record({ to: null, action: "skipped", reason: "no Jev API key" });
        continue;
      } else {
        try {
          const result = await jev.classify(request.state, request.questions);
          const answer = choiceAnswer(result, "label");
          if (!answer) throw new Error("Jev returned no label answer");
          const d = decideTab(answer, entry.pick ?? entry.auto, others, { ...naming, maxLength: cfg.maxTabLength });
          detail = { pick: d.pick };
          if (!d.confident) {
            entry.fp = fp;
            record({ to: d.name, action: "kept", reason: "Jev was not confident enough", detail });
            continue;
          }
          pick = d.pick.value;
          name = d.name;
        } catch (error) {
          record({ to: null, action: "error", reason: errorText(error) });
          continue;
        }
      }
      if (!name) {
        // Nothing left to call it, e.g. the pane it was named after closed: a name the plugin gave,
        // or a placeholder, goes back to herdr's default, the tab's position in the workspace.
        const ours = !!entry.auto && tab.label === entry.auto && !/^\d+$/.test(entry.auto);
        // A placeholder tab label is stale once its panes dropped theirs after their agent exited;
        // a new orb whose agent hasn't started yet keeps it.
        const tabPanes = snap.panes.filter((p) => p.tab_id === id);
        const stalePlaceholder =
          isDefaultPaneLabel(placeholders)(tab.label) &&
          tabPanes.every((p) => !isDefaultPaneLabel(placeholders)(paneLabel.get(p.pane_id) ?? "")) &&
          tabPanes.some((p) => state.panes[p.pane_id]?.lastAgent);
        if (ours || stalePlaceholder) {
          const position = String(snap.tabs.filter((t) => t.workspace_id === tab.workspace_id).indexOf(tab) + 1);
          if (opts.dryRun) record({ to: position, action: "would-rename", reason: "would reset to its number: nothing to name it after" });
          else {
            try {
              await herdr.renameTab(id, position);
              tabLabel.set(id, position);
              Object.assign(entry, { auto: position, pick: null, at: Date.now() });
              record({ to: position, action: "cleared", reason: "reset to its number: nothing to name it after" });
            } catch (error) {
              record({ to: position, action: "error", reason: errorText(error) });
              continue;
            }
          }
        }
        entry.fp = fp;
        continue;
      }
      if (name === tab.label) {
        Object.assign(entry, { auto: name, pick, fp });
        continue;
      }
      if (opts.dryRun) {
        tabLabel.set(id, name);
        record({ to: name, action: "would-rename", reason: "dry run", detail });
        continue;
      }
      entry.pending = name;
      persist();
      try {
        await herdr.renameTab(id, name);
      } catch (error) {
        entry.pending = null;
        delete entry.fp;
        record({ to: name, action: "error", reason: errorText(error), detail });
        continue;
      }
      tabLabel.set(id, name);
      Object.assign(entry, { auto: name, pick, pending: null, fp, at: Date.now() });
      persist();
      record({ to: name, action: "renamed", reason: "", detail });
    }
  }

  // A dry run saves nothing, but still throttles focus events so hooks in dry-run mode stay cheap.
  if (opts.dryRun || store.save(state)) store.markSwept();
  for (const d of decisions) store.log({ ...d, dryRun: opts.dryRun || undefined });
  return decisions;
}
