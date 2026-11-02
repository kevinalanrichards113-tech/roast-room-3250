import { env } from "./env.mjs";

// Meta Model API provider for the Roast Room 3250.
// Same interface as the original Anthropic client (stream / json / S / usage),
// backed by the Meta Responses API (https://api.meta.ai/v1/responses),
// the endpoint Kevin's ClassPrep Autopilot verified on Oct 28, 2026.
// Key: MODEL_API_KEY (or META_API_KEY) from the environment or the project .env.
// Model: META_MODEL or muse-spark-1.3. Muse Spark is a reasoning model: most
// of the output budget goes to reasoning tokens, so max_output_tokens is
// floored at 4000 or responses come back empty with status "incomplete".

const URL = "https://api.meta.ai/v1/responses";
const RETRY = new Set([429, 500, 502, 503, 529]);
const MIN_TOKENS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const apiKey = () => env("MODEL_API_KEY") || env("META_API_KEY");
const model = () => env("META_MODEL") || "muse-spark-1.3";

export const hasKey = () => Boolean(apiKey());

function headers() {
  return {
    authorization: `Bearer ${apiKey()}`,
    "content-type": "application/json",
  };
}

// Running token tally for the whole app, shown in the UI.
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
function addUsage(u = {}) {
  usage.input += u.input_tokens || 0;
  usage.output += u.output_tokens || 0;
  usage.calls += 1;
}

const flatten = (x) => {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(flatten).filter(Boolean).join("\n");
  if (typeof x === "object") return x.text || flatten(x.content) || "";
  return String(x);
};

function extractText(resp) {
  if (resp.output_text) return resp.output_text;
  const parts = [];
  for (const item of resp.output || []) {
    for (const c of item.content || []) {
      if ((c.type === "output_text" || c.type === "text") && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n");
}

async function callResponses({ instructions, input, maxTokens }) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: model(),
        instructions: instructions || undefined,
        input,
        max_output_tokens: Math.max(maxTokens || 0, MIN_TOKENS),
      }),
    });
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Meta Model API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    addUsage(j.usage);
    const text = extractText(j);
    if (!text) {
      lastErr = new Error(`Meta Model API returned no text (status: ${j.status || "unknown"})`);
      await sleep(1000);
      continue;
    }
    return text;
  }
  throw lastErr || new Error("Meta Model API kept refusing after retries");
}

const inputFrom = (messages) =>
  (messages || []).map((m) => flatten(m.content)).filter(Boolean).join("\n\n");

/** "Stream" a message: the Responses call is made whole, then the text is
 *  fed to onText in small chunks so the room's talking animation plays. */
export async function stream({ system, messages, maxTokens = 2000, onText = () => {} }) {
  const text = await callResponses({
    instructions: flatten(system),
    input: inputFrom(messages),
    maxTokens,
  });
  const chunks = text.match(/\S+\s*/g) || [text];
  for (const c of chunks) onText(c);
  return text;
}

/** Extract and parse the JSON object in a model reply. One cheap salvage is
 *  attempted (trailing commas before a closing bracket); anything worse is
 *  the caller's signal to ask the model again. */
export function parseChairJson(raw) {
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Chair output was not JSON");
  const slice = cleaned.slice(start, end + 1);
  try { return JSON.parse(slice); }
  catch (e) {
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); }
    catch { throw e; }
  }
}

/** One call with structured JSON output matching `schema`. The schema is
 *  given to the model as an instruction. If the reply is not valid JSON
 *  (an unescaped quote, a dropped comma), the model is asked again with the
 *  parse error named, up to three attempts in total, before giving up. */
export async function json({ system, prompt, schema, maxTokens = 4000 }) {
  const base =
    flatten(system) +
    "\n\nRespond with a single JSON object that matches this JSON schema exactly. No prose, no markdown, no code fences.\n" +
    JSON.stringify(schema);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const instructions = attempt === 0 ? base
      : base + `\n\nYour previous reply was not valid JSON (${lastErr ? lastErr.message : "parse error"}). Reply again with ONLY the JSON object: escape every quote inside a string and close every array and object.`;
    const raw = await callResponses({ instructions, input: prompt, maxTokens });
    try { return parseChairJson(raw); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Chair output was not JSON");
}

// JSON schema helpers (unchanged from the original client)
export const S = {
  str: { type: "string" },
  num: { type: "number" },
  int: { type: "integer" },
  bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
  enum: (...v) => ({ type: "string", enum: v }),
};
