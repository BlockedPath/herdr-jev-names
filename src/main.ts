/**
 * Entry point for herdr hooks and actions (see herdr-plugin.toml), plus CLI helpers:
 *
 *   run.sh event                 startup hook and pane/tab events
 *   run.sh action name-all       decide every pane and tab again
 *   run.sh action name-here      name the focused pane and tab, even if someone else named them
 *   run.sh action explain        show why the focused pane would get its name
 *   run.sh dry-run               print what would change, without renaming anything
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import type { Decision, Deps, SweepOptions } from "./engine";
import { sweep } from "./engine";
import { HerdrCli } from "./herdr";
import { JevClient } from "./jev";
import type { QueueItem } from "./state";
import { Store } from "./state";

const TITLE = "Jev Names";
const FOCUS_EVENTS = new Set(["pane.focused", "tab.focused", "workspace.focused"]);
const FOCUS_THROTTLE_MS = 8_000;

function context(): Record<string, any> {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function eventItem(): QueueItem {
  const event = process.env.HERDR_PLUGIN_EVENT || "startup";
  let data: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "null");
    data = parsed?.data ?? parsed ?? undefined;
  } catch {
    data = undefined;
  }
  return { type: "event", event, data };
}

/** Merges queued items into one sweep. */
export function plan(items: QueueItem[], dryRun: boolean): SweepOptions {
  const opts: SweepOptions = { dryRun, forcePanes: new Set(), forceTabs: new Set(), moves: [] };
  for (const item of items) {
    if (item.type === "name-all") opts.reevaluate = true;
    else if (item.type === "name-here") {
      if (item.paneId) opts.forcePanes!.add(item.paneId);
      if (item.tabId) opts.forceTabs!.add(item.tabId);
      opts.unlock = true;
    } else if (item.event === "pane.moved") {
      const from = item.data?.previous_pane_id;
      const to = (item.data?.pane as { pane_id?: string } | undefined)?.pane_id;
      if (typeof from === "string" && typeof to === "string") opts.moves!.push([from, to]);
    }
  }
  return opts;
}

function deps(): Deps {
  const cfg = loadConfig();
  const store = new Store(cfg.stateDir, process.env.HERDR_SOCKET_PATH || "default");
  // One retry: a hook that waits out a long outage only delays the next event's run.
  const jev = cfg.apiKey ? new JevClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: 8_000, maxRetries: 1 }) : null;
  return { herdr: new HerdrCli(), jev, store, cfg };
}

/** At most one "add your key" notification every 12 hours. */
async function warnMissingKey(d: Deps): Promise<void> {
  const marker = join(d.store.dir, "warned-missing-key");
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 12 * 3_600_000) return;
  writeFileSync(marker, "");
  await d.herdr.notify(TITLE, `Add TYPESAFE_API_KEY to ${join(d.cfg.configDir, "config.env")} to start naming panes and tabs.`);
}

function summarize(decisions: Decision[]): string {
  const changed = decisions.filter((d) => d.action === "renamed" || d.action === "would-rename");
  return changed.map((d) => `${d.kind} ${d.id}: ${d.from ?? "∅"} → ${d.to}`).join("\n");
}

/** Runs queued work while holding the lock. Others enqueue and leave; the holder picks it up. */
async function process_(d: Deps, item: QueueItem): Promise<void> {
  d.store.enqueue(item);
  for (let waited = 0; ; waited += 100) {
    if (d.store.tryLock()) break;
    if (waited >= 1500) return; // the holder will drain our item
    await Bun.sleep(100);
  }
  try {
    for (let round = 0; round < 20; round++) {
      for (let pass = 0; pass < 20 && d.store.hasPending(); pass++) {
        const items = d.store.drain();
        if (!items.length) break;
        let decisions: Decision[];
        try {
          decisions = await sweep(d, plan(items, d.cfg.dryRun));
        } catch (error) {
          // Keep moves and name-here requests for the next run.
          for (const it of items) d.store.enqueue(it);
          throw error;
        }
        for (const dec of decisions) if (dec.action === "error") console.error(`jev-names: ${dec.kind} ${dec.id}: ${dec.reason}`);
        const changes = summarize(decisions);
        if (changes) console.log(changes);
      }
      d.store.unlock();
      // An event may have queued between the last drain and the unlock.
      if (!d.store.hasPending() || !d.store.tryLock()) return;
    }
  } finally {
    d.store.unlock();
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const d = deps();

  if (command === "event") {
    if (!d.jev) return warnMissingKey(d);
    const item = eventItem();
    // Focus changes are frequent; they only serve to catch commands started in plain shells.
    if (item.type === "event" && FOCUS_EVENTS.has(item.event) && d.store.sweptWithin(FOCUS_THROTTLE_MS)) return;
    return process_(d, item);
  }

  if (command === "action") {
    if (!d.jev) {
      await d.herdr.notify(TITLE, `No Jev API key. Add TYPESAFE_API_KEY to ${join(d.cfg.configDir, "config.env")}.`);
      return;
    }
    const ctx = context();
    if (arg === "name-all") return process_(d, { type: "name-all" });

    const snap = await d.herdr.snapshot();
    const paneId: string | null = ctx.focused_pane_id ?? process.env.HERDR_PANE_ID ?? snap.focused_pane_id ?? null;
    const tabId = snap.panes.find((p) => p.pane_id === paneId)?.tab_id ?? ctx.tab_id ?? snap.focused_tab_id ?? null;
    if (arg === "name-here") return process_(d, { type: "name-here", paneId, tabId });

    if (arg === "explain") {
      const decisions = await sweep(d, {
        dryRun: true,
        reevaluate: true,
        forcePanes: new Set(paneId ? [paneId] : []),
        forceTabs: new Set(tabId ? [tabId] : []),
        unlock: true,
        only: { panes: new Set(paneId ? [paneId] : []), tabs: new Set(tabId ? [tabId] : []) },
      });
      const lines = decisions.map((dec) => {
        const what = dec.detail?.what as { value: string; probability: number } | undefined;
        const subject = dec.detail?.subject as { value: string; probability: number } | undefined;
        const pick = dec.detail?.pick as { value: string; probability: number } | undefined;
        const why = [what && `${what.value} ${what.probability.toFixed(2)}`, subject && `“${subject.value}” ${subject.probability.toFixed(2)}`, pick && `“${pick.value}” ${pick.probability.toFixed(2)}`]
          .filter(Boolean)
          .join(", ");
        return `${dec.kind}: ${dec.to ?? dec.from ?? "∅"} (${dec.action}${why ? `; ${why}` : ""}${dec.reason && dec.reason !== "dry run" ? `; ${dec.reason}` : ""})`;
      });
      await d.herdr.notify(TITLE, lines.join("\n") || "Nothing to name here yet.");
      console.log(lines.join("\n"));
      return;
    }
    throw new Error(`unknown action: ${arg}`);
  }

  if (command === "dry-run") {
    if (!d.jev) throw new Error("no Jev API key: set TYPESAFE_API_KEY or add it to config.env");
    const decisions = await sweep(d, { dryRun: true, reevaluate: true });
    for (const dec of decisions) console.log(JSON.stringify(dec));
    return;
  }

  console.error("usage: run.sh event | action <name-all|name-here|explain> | dry-run");
  process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`jev-names: ${(error as Error).stack ?? error}`);
    process.exitCode = 1;
  });
}
