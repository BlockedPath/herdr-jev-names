import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  dryRun: boolean;
  panes: boolean;
  tabs: boolean;
  sendOutput: boolean;
  sendPrompts: boolean;
  /** Labels set by other tools that may be replaced, compared case-insensitively. */
  placeholders: string[];
  maxPaneLength: number;
  maxTabLength: number;
  /** Lowest top probability Jev must give a choice before it is applied. */
  minProbability: number;
  /** How much more likely a new choice must be than the current one to replace it. */
  hysteresis: number;
  separator: string;
  configDir: string;
  stateDir: string;
}

/** Parses KEY=VALUE lines. Supports `export`, quotes and # comments; does not expand variables. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Settings come from the environment, then `config.env` in the plugin config dir, then defaults.
 * The environment wins so a one-off `JEV_NAMES_DRY_RUN=1` works from a shell.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? "";
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR || join(home, ".config/herdr/plugins/config/blockedpath.jev-names");
  const stateDir = env.HERDR_PLUGIN_STATE_DIR || join(home, ".local/state/herdr/plugins/blockedpath.jev-names");
  const file = join(configDir, "config.env");
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const get = (key: string) => (env[key] !== undefined && env[key] !== "" ? env[key] : fromFile[key]);

  return {
    apiKey: get("TYPESAFE_API_KEY") ?? get("JEV_API_KEY") ?? "",
    baseUrl: (get("JEV_BASE_URL") ?? "https://api.typesafe.ai/v1").replace(/\/+$/, ""),
    model: get("JEV_MODEL") ?? "jev-latest",
    dryRun: bool(get("JEV_NAMES_DRY_RUN"), false),
    panes: bool(get("JEV_NAMES_PANES"), true),
    tabs: bool(get("JEV_NAMES_TABS"), true),
    sendOutput: bool(get("JEV_NAMES_SEND_OUTPUT"), true),
    sendPrompts: bool(get("JEV_NAMES_SEND_PROMPTS"), true),
    placeholders: (get("JEV_NAMES_PLACEHOLDERS") ?? "new orb")
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxPaneLength: Math.max(8, num(get("JEV_NAMES_MAX_PANE_LENGTH"), 32)),
    maxTabLength: Math.max(6, num(get("JEV_NAMES_MAX_TAB_LENGTH"), 24)),
    minProbability: num(get("JEV_NAMES_MIN_PROBABILITY"), 0.3),
    hysteresis: num(get("JEV_NAMES_HYSTERESIS"), 0.15),
    separator: get("JEV_NAMES_SEPARATOR") ?? " · ",
    configDir,
    stateDir,
  };
}
