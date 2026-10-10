import { afterAll, describe, expect, test } from "bun:test";
import { JevClient } from "../src/jev";

const requests: Array<{ auth: string | null; body: any }> = [];
let failuresLeft = 0;
let failStatus = 529;
let rejectSpacedKeys = false;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    requests.push({ auth: req.headers.get("authorization"), body });
    if (new URL(req.url).pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
    if (rejectSpacedKeys && Object.values<any>(body.questions).some((q) => Object.keys(q.criteria ?? {}).some((k) => !/^[a-z0-9_]+$/.test(k)))) {
      return new Response(JSON.stringify({ detail: "questions.subject.criteria: invalid key" }), { status: 422 });
    }
    if (failuresLeft > 0) {
      failuresLeft--;
      return new Response(JSON.stringify({ error: "busy" }), { status: failStatus });
    }
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      const options = Object.keys(q.criteria);
      // Picks the last option, so the test can tell a key mapping apart from position 0.
      const pick = options[options.length - 1];
      answers[id] = { type: "choice", choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])), confidence: 1 };
    }
    return Response.json({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } });
  },
});

afterAll(() => server.stop(true));

const client = () => new JevClient({ apiKey: "test-key", baseUrl: `http://localhost:${server.port}/v1`, model: "jev-latest", timeoutMs: 2000 });

describe("JevClient", () => {
  test("posts model, state and questions with a bearer token", async () => {
    requests.length = 0;
    const res = await client().classify({ pane: { x: 1 } }, { q: { type: "choice", instructions: "pick", criteria: { a: "A", b: null } } });
    expect(res.answers.q).toMatchObject({ type: "choice", choice: "b" });
    expect(requests[0]!.auth).toBe("Bearer test-key");
    expect(requests[0]!.body).toEqual({ model: "jev-latest", state: { pane: { x: 1 } }, questions: { q: { type: "choice", instructions: "pick", criteria: { a: "A", b: null } } } });
  });

  test("retries overload responses", async () => {
    requests.length = 0;
    failuresLeft = 2;
    failStatus = 529;
    const res = await client().classify("s", { q: { type: "choice", instructions: "pick", criteria: { a: "A" } } });
    expect(res.answers.q).toBeDefined();
    expect(requests.length).toBe(3);
  });

  test("does not retry validation errors", async () => {
    requests.length = 0;
    failuresLeft = 1;
    failStatus = 422;
    await expect(client().classify("s", { q: { type: "choice", instructions: "pick", criteria: { a: "A" } } })).rejects.toThrow(/422/);
    expect(requests.length).toBe(1);
    failuresLeft = 0;
  });

  test("falls back to plain option keys when names are rejected", async () => {
    requests.length = 0;
    rejectSpacedKeys = true;
    const c = client();
    const q = { subject: { type: "choice" as const, instructions: "pick", criteria: { "server · web": "a", "nothing specific": null } } };
    const res = await c.classify("s", q);
    expect(res.answers.subject).toMatchObject({ choice: "nothing specific", probabilities: { "server · web": 0, "nothing specific": 1 } });
    expect(requests.length).toBe(2);
    expect(requests[1]!.body.questions.subject.criteria).toEqual({ o1: { name: "server · web", about: "a" }, o2: { name: "nothing specific" } });
    await c.classify("s", q); // later requests go straight to plain keys
    expect(requests.length).toBe(3);
    rejectSpacedKeys = false;
  });
});
