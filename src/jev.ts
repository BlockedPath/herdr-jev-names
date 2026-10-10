/** Client for TypeSafe's System One API (`POST {base}/systemone`), which serves Jev. */

export type Criteria = string | null | Record<string, unknown> | unknown[];

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, Criteria> }
  | { type: "noul"; instructions: string; criteria?: { true: Criteria; false: Criteria } }
  | { type: "score"; instructions: string; criteria: Criteria[] };

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities?: Record<string, number>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface ClassifyResult {
  model?: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Classifier {
  classify(state: unknown, questions: Record<string, Question>): Promise<ClassifyResult>;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface JevOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const PLAIN_KEY = /^[a-z0-9_]+$/;

/**
 * Choice options keyed `o1`, `o2`, … with the real names moved into the descriptions, and the map
 * back. The API documents no rules for option keys and its examples use snake_case, so this is
 * the fallback when names with spaces or punctuation are rejected.
 */
export function withPlainKeys(questions: Record<string, Question>): { questions: Record<string, Question>; names: Record<string, Record<string, string>> } {
  const out: Record<string, Question> = {};
  const names: Record<string, Record<string, string>> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== "choice" || Object.keys(q.criteria).every((k) => PLAIN_KEY.test(k))) {
      out[id] = q;
      continue;
    }
    const criteria: Record<string, Criteria> = {};
    names[id] = {};
    Object.entries(q.criteria).forEach(([name, description], i) => {
      const key = `o${i + 1}`;
      names[id]![key] = name;
      criteria[key] = description === null ? { name } : { name, about: description };
    });
    out[id] = { ...q, instructions: `${q.instructions} Each option's \`name\` is the label it stands for.`, criteria };
  }
  return { questions: out, names };
}

function restoreNames(result: ClassifyResult, names: Record<string, Record<string, string>>): ClassifyResult {
  const answers = { ...result.answers };
  for (const [id, map] of Object.entries(names)) {
    const a = answers[id];
    if (!a || a.type !== "choice") continue;
    answers[id] = {
      ...a,
      choice: map[a.choice] ?? a.choice,
      probabilities: Object.fromEntries(Object.entries(a.probabilities ?? {}).map(([k, v]) => [map[k] ?? k, v])),
    };
  }
  return { ...result, answers };
}

export class JevClient implements Classifier {
  /** Set after the API rejects option names as keys; later requests in this process skip the attempt. */
  private plainKeys = false;

  constructor(readonly opts: JevOptions) {}

  async classify(state: unknown, questions: Record<string, Question>): Promise<ClassifyResult> {
    if (!this.plainKeys) {
      try {
        return await this.send(state, questions);
      } catch (error) {
        if (!(error instanceof JevError) || error.status !== 422) throw error;
        const plain = withPlainKeys(questions);
        if (!Object.keys(plain.names).length) throw error;
        const result = restoreNames(await this.send(state, plain.questions), plain.names);
        this.plainKeys = true;
        return result;
      }
    }
    const plain = withPlainKeys(questions);
    return restoreNames(await this.send(state, plain.questions), plain.names);
  }

  private async send(state: unknown, questions: Record<string, Question>): Promise<ClassifyResult> {
    const { apiKey, baseUrl, model, timeoutMs = 10_000, maxRetries = 2 } = this.opts;
    const doFetch = this.opts.fetch ?? fetch;
    const body = JSON.stringify({ model, state, questions });
    let lastError: JevError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await Bun.sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200));
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new JevError(`Jev request failed: ${(error as Error).message}`);
        continue;
      }
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as ClassifyResult | null;
        if (!json || typeof json.answers !== "object" || json.answers === null) throw new JevError("Jev returned an unexpected response");
        return json;
      }
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      lastError = new JevError(`Jev returned ${res.status}: ${detail}`, res.status);
      if (!RETRY_STATUSES.has(res.status)) break;
    }
    throw lastError ?? new JevError("Jev request failed");
  }
}

/** The answer to a choice question, or null when it is missing or malformed. */
export function choiceAnswer(result: ClassifyResult, id: string): ChoiceAnswer | null {
  const a = result.answers[id];
  if (!a || a.type !== "choice" || typeof a.choice !== "string" || typeof a.probabilities !== "object") return null;
  return a;
}
