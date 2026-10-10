import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchTopic, foregroundCommand, sessionPrompts, titlePhrases, userRequest } from "../src/context";

describe("titlePhrases", () => {
  test("keeps the task from an amp title", () => {
    expect(titlePhrases("Meta hooks race - amp - ~/dev/pi-meta-oauth", { agent: "amp", project: "pi-meta-oauth", cwd: "/Users/x/dev/pi-meta-oauth" })).toEqual(["Meta hooks race"]);
  });

  test("drops a pi title that only names the agent and project", () => {
    expect(titlePhrases("π - bounty", { agent: "pi", displayAgent: "π", project: "bounty", cwd: "/x/bounty" })).toEqual([]);
  });

  test("drops shells, paths and user@host", () => {
    expect(titlePhrases("zsh", {})).toEqual([]);
    expect(titlePhrases("~/dev/test", {})).toEqual([]);
    expect(titlePhrases("justin@mbp: ~/dev", {})).toEqual([]);
  });

  test("keeps a Claude Code topic after its spinner", () => {
    expect(titlePhrases("✳ Herdr Jev plugin", { agent: "claude" })).toEqual(["Herdr Jev plugin"]);
  });
});

describe("foregroundCommand", () => {
  test("ignores the shell", () => {
    expect(foregroundCommand([{ argv: ["-zsh"], name: "zsh" }])).toBeNull();
  });

  test("returns the running command", () => {
    expect(foregroundCommand([{ argv: ["/opt/homebrew/bin/bun", "run", "dev"], name: "bun" }])).toEqual(["bun", "run", "dev"]);
  });

  test("uses argv0 for node-hosted CLIs", () => {
    expect(foregroundCommand([{ argv0: "pi", name: "node" }])).toEqual(["pi"]);
  });
});

describe("branchTopic", () => {
  test("ignores default branches and strips prefixes", () => {
    expect(branchTopic("main")).toBeNull();
    expect(branchTopic("feat/auth-refactor")).toBe("auth refactor");
    expect(branchTopic("justin/ENG-123-login-redirect")).toBe("login redirect");
  });
});

describe("session transcripts", () => {
  test("reads pi, Claude Code and Codex user requests and skips injected context", () => {
    expect(userRequest(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "how does this codebase look" }] } }))).toBe("how does this codebase look");
    expect(userRequest(JSON.stringify({ type: "user", message: { role: "user", content: "fix the login redirect" } }))).toBe("fix the login redirect");
    expect(userRequest(JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/advisor</command-name>" } }))).toBeNull();
    expect(userRequest(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }))).toBeNull();
    expect(userRequest(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } }))).toBeNull();
    expect(userRequest(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add retries" }] } }))).toBe("add retries");
  });

  test("finds the first and latest request", () => {
    const dir = mkdtempSync(join(tmpdir(), "jevnames-"));
    const file = join(dir, "s.jsonl");
    const msg = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    const reply = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(file, [JSON.stringify({ type: "session" }), msg("first ask"), reply("ok"), msg("try now for clef"), reply("done"), msg("second ask"), reply("Clef is working again"), ""].join("\n"));
    expect(sessionPrompts(file)).toEqual({ first: "first ask", last: "second ask", earlier: ["try now for clef", "first ask"], reply: "Clef is working again", files: [] });
  });
});
