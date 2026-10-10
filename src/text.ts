/** Text helpers shared by context collection and naming. */

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Braille spinners, box drawing, block elements, and other control-ish symbols agents put in titles.
const DECORATION = /[⠀-⣿─-▟■-◿✀-➿←-⇿⌀-⏿·•…✱-✿]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const REDACTED = "[redacted]";

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|pass|pwd|auth|credential|private[_-]?key|signing[_-]?key|encryption[_-]?key|access[_-]?key|session|cookie|dsn|webhook)[A-Za-z0-9_.-]*`;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM blocks, including a body whose BEGIN line scrolled out of view.
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
  [/(?:^[A-Za-z0-9+/=]{16,}\n)+-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/gm, REDACTED],
  [/^(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{60,76}={0,2}$/gm, REDACTED],
  // Passwords in URLs: postgres://user:pass@host, https://user:token@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // Secret query parameters: ?token=, &sig=, ?key=.
  [/([?&#](?:key|sig|signature|code|auth|pass(?:word)?|pwd|secret|token|apikey|api_key|access_token|client_secret)[^=&\s]*=)[^&\s#"']+/gi, `$1${REDACTED}`],
  // HTTP headers.
  [/\b(authorization\s*:\s*)(?:\w+\s+)?[^\s"',]{8,}/gi, `$1${REDACTED}`],
  [/\b((?:set-)?cookie\s*:\s*).*/gi, `$1${REDACTED}`],
  // key=value, key: value and "key": "value" (JSON), keeping the key so the context stays readable.
  [new RegExp(String.raw`(\b${SECRET_NAME}["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)`, "gi"), `$1${REDACTED}`],
  // UPPER_SNAKE environment names ending in a secret-ish word: SMTP_PASS=, SIGNING_KEY=.
  [/\b([A-Z][A-Z0-9_]*_(?:KEY|PASS|PWD|DSN|SECRET|TOKEN|URL|URI)\s*=\s*)\S+/g, `$1${REDACTED}`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, `hooks.slack.com/services/${REDACTED}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\b[A-Fa-f0-9]{40,}\b/g, REDACTED],
  // Long opaque tokens with letters and digits. Slashes are excluded so file paths survive.
  [/(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, REDACTED],
];

/** Replaces strings that look like credentials before anything leaves the machine. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Last `maxLines` non-empty lines of terminal output, without ANSI codes, at most `maxChars`. */
export function cleanOutput(text: string, maxLines: number, maxChars: number): string {
  const lines = stripAnsi(text)
    .replace(/\r/g, "")
    .split("\n")
    // TUIs pad lines and draw scrollbars and borders with box and block characters.
    .map((l) => l.replace(/[\u2500-\u259f]/g, " ").replace(/\s+$/, "").replace(/(\S)\s{3,}/g, "$1  "))
    .filter((l) => l.trim() !== "");
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

/** Collapses whitespace and removes control and decoration characters. */
export function tidy(text: string): string {
  return stripAnsi(text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(DECORATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shortens to `max` characters (code points), ending in an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const atWord = cut.replace(/\s+\S*$/, "");
  return (atWord.length >= max * 0.6 ? atWord : cut).replace(/[\s·:,;.-]+$/, "") + "…";
}

export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Short stable hash for change detection. */
export function digest(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(typeof value === "string" ? value : JSON.stringify(value));
  return hasher.digest("hex").slice(0, 16);
}
