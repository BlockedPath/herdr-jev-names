import { describe, expect, test } from "bun:test";
import { parseEnvFile } from "../src/config";
import { cleanOutput, redact, tidy, truncate } from "../src/text";

describe("redact", () => {
  test("hides common credential shapes", () => {
    // Built at runtime so the fixtures do not look like real secrets to scanners.
    const openai = "sk-" + "proj-" + "abcdefghijklmnop1234567890";
    const github = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const aws = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
    const bearer = "abcdefghijklmnopqrstuvwxyz012345";
    const text = [`export OPENAI_API_KEY=${openai}`, `Authorization: Bearer ${bearer}`, `token: ${github}`, `aws ${aws}`, 'password = "hunter2hunter2"'].join("\n");
    const out = redact(text);
    for (const secret of [openai, github, aws, bearer, "hunter2"]) expect(out).not.toContain(secret);
    expect(out).toContain("OPENAI_API_KEY=[redacted]");
  });

  test("keeps ordinary paths and words", () => {
    const text = "/Users/justin/dev/pi-xai-oauth/node_modules/@earendil-works/pi-coding-agent/dist/index.js failed";
    expect(redact(text)).toBe(text);
    expect(redact("fix the meta hooks race")).toBe("fix the meta hooks race");
  });
});

describe("text helpers", () => {
  test("truncate cuts at a word and adds an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    const t = truncate("investigate flaky websocket reconnect tests", 24);
    expect(Array.from(t).length).toBeLessThanOrEqual(24);
    expect(t.endsWith("…")).toBe(true);
  });

  test("cleanOutput strips ansi and keeps the tail", () => {
    const raw = "\x1b[32mok\x1b[0m line1\n\n line2  \nline3\n";
    expect(cleanOutput(raw, 2, 100)).toBe(" line2\nline3");
  });

  test("tidy removes spinners and collapses whitespace", () => {
    expect(tidy("⢤  Meta hooks\trace ")).toBe("Meta hooks race");
  });

  test("parseEnvFile handles export, quotes and comments", () => {
    const env = parseEnvFile(`# comment\nexport TYPESAFE_API_KEY="abc def"\nJEV_MODEL=jev-1.13 # pinned\nBAD LINE\nJEV_NAMES_PLACEHOLDERS='new orb|shell'\n`);
    expect(env).toEqual({ TYPESAFE_API_KEY: "abc def", JEV_MODEL: "jev-1.13", JEV_NAMES_PLACEHOLDERS: "new orb|shell" });
  });
});
