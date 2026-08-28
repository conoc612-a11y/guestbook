import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const HF_ONNX = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx`;
const ORT_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.webgpu.bundle.min.mjs";

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { dims: number[]; data: Float32Array }>>;
}

export interface DocChunk {
  id: string;
  text: string;
  url: string;
  section: string;
  vector: number[];
}

let session: OrtSession | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let ready: Promise<void> | null = null;

export type EmbedProgress = { pct: number; file: string; cached?: boolean };
let progressCb: ((p: EmbedProgress) => void) | null = null;
export function onEmbedProgress(cb: (p: EmbedProgress) => void) {
  progressCb = cb;
}

export async function peekModelCache(): Promise<boolean> {
  try {
    const c = await caches.open(MODEL_CACHE);
    return (await c.match(`${HF_ONNX}/model_no_gather_q4.onnx_data`)) !== undefined;
  } catch {
    return false;
  }
}

const MODEL_CACHE = "matjip-embed-v1";

async function fetchWithProgress(url: string, file: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      progressCb?.({ pct: 100, file, cached: true });
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`모델 파일 내려받기 실패 (${res.status}): ${file}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const pct = Math.round((got / total) * 100);
    if (pct !== lastPct) { lastPct = pct; progressCb?.({ pct, file }); }
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  if (cache) await putWithRetry(cache, url, out);
  return out;
}

async function putWithRetry(cache: Cache, url: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try { await cache.put(url, new Response(body)); return; }
    catch { await new Promise((r) => setTimeout(r, 400)); }
  }
}

function ensureReady(): Promise<void> {
  if (session && tokenizer) return Promise.resolve();
  if (!ready) {
    ready = (async () => {
      navigator.storage?.persist?.().catch(() => undefined);
      const ort = (await import(/* @vite-ignore */ ORT_URL)) as {
        InferenceSession: { create(
          buf: Uint8Array,
          opts: { executionProviders: string[]; externalData: { path: string; data: Uint8Array }[] },
        ): Promise<OrtSession> };
      };
      const core = await fetchWithProgress(`${HF_ONNX}/model_no_gather_q4.onnx`, "model_no_gather_q4.onnx");
      const data = await fetchWithProgress(`${HF_ONNX}/model_no_gather_q4.onnx_data`, "model_no_gather_q4.onnx_data");
      session = await ort.InferenceSession.create(core, {
        executionProviders: ["wasm"],
        externalData: [{ path: "model_no_gather_q4.onnx_data", data }],
      });
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function embed(text: string): Promise<number[]> {
  await ensureReady();
  const { input_ids, attention_mask } = await tokenizer!(text);
  const out = await session!.run({ input_ids, attention_mask });
  const hs = out.last_hidden_state;
  const [, seq, hid] = hs.dims;
  const am = attention_mask.data as ArrayLike<bigint> | ArrayLike<number>;
  const acc = new Float64Array(hid);
  let cnt = 0;
  for (let s = 0; s < seq; s++) {
    const w = Number(am[s]);
    cnt += w;
    if (!w) continue;
    for (let h = 0; h < hid; h++) acc[h] += hs.data[s * hid + h];
  }
  let norm = 0;
  for (let h = 0; h < hid; h++) { acc[h] /= cnt; norm += acc[h] * acc[h]; }
  norm = Math.sqrt(norm);
  const vec = new Array<number>(hid);
  for (let h = 0; h < hid; h++) vec[h] = acc[h] / norm;
  return vec;
}

let corpus: DocChunk[] | null = null;

export async function loadCorpus(): Promise<DocChunk[]> {
  if (corpus) return corpus;
  const res = await fetch(`${import.meta.env.BASE_URL}guestbook-docs.json`);
  if (!res.ok) throw new Error(`docs 로드 실패: ${res.status}`);
  corpus = (await res.json()) as DocChunk[];
  return corpus;
}

export interface Retrieved {
  chunk: DocChunk;
  score: number;
  method: "vector" | "bm25";
}

const STOPWORDS = new Set([
  "에서", "에게", "한테", "부터", "까지", "처럼", "같이", "마다", "보다", "라는",
  "무엇", "언제", "어디", "누구", "어떤", "어떻게", "왜요", "인가요", "나요",
  "있는", "없는", "하는", "했던", "하는지", "인지", "이며", "하고",
  "주세요", "알려줘", "알려주세요", "가르쳐", "가르쳐줘", "말해줘", "해줘",
  "해주세요", "해주실", "그리고", "그래서", "하지만", "그런데", "근데",
  "the", "is", "what", "when", "where", "how", "about", "please", "tell",
]);

function queryTerms(q: string): string[] {
  return q.toLowerCase().split(/[^가-힣a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function bm25(docs: DocChunk[], terms: string[]): { chunk: DocChunk; score: number }[] {
  if (!terms.length) return [];
  const toks = docs.map((d) => queryTerms(d.text));
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const t of new Set(terms)) {
    df.set(t, toks.reduce((n, dt) => n + (dt.some((x) => x.includes(t)) ? 1 : 0), 0));
  }
  return docs.map((chunk, i) => {
    const dl = toks[i].length || 1;
    let score = 0;
    for (const [t, dfv] of df) {
      if (!dfv) continue;
      let tf = 0;
      for (const x of toks[i]) if (x.includes(t)) tf++;
      if (!tf) continue;
      const idf = Math.log((docs.length - dfv + 0.5) / (dfv + 0.5) + 1);
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
    }
    return { chunk, score };
  });
}

export async function retrieve(question: string, k = 15): Promise<Retrieved[]> {
  const [docs, q] = await Promise.all([loadCorpus(), embed(question)]);
  const vec = docs
    .map((chunk) => {
      let dot = 0;
      const v = chunk.vector;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      return { chunk, score: dot, method: "vector" as const };
    })
    .sort((a, b) => b.score - a.score);
  const topVec = vec.slice(0, Math.min(10, k));
  const picked = new Set(topVec.map((r) => r.chunk.id));
  const scored = bm25(docs, queryTerms(question))
    .filter((r) => r.score > 0 && !picked.has(r.chunk.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k - topVec.length));
  const top = scored[0]?.score ?? 0;
  const lex = scored.map((r) => ({
    chunk: r.chunk,
    score: top > 0 ? r.score / top : 0,
    method: "bm25" as const,
  }));
  for (const r of lex) picked.add(r.chunk.id);
  const rest = vec.filter((r) => !picked.has(r.chunk.id)).slice(0, k - topVec.length - lex.length);
  return [...topVec, ...lex, ...rest];
}

export function buildPrompt(question: string, hits: Retrieved[]): string {
  const now = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "long", day: "numeric", weekday: "long",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date());
  const context = hits
    .map((h) => `[${h.chunk.id} | ${h.chunk.section}] ${h.chunk.text}`)
    .join("\n\n");
  const best = hits[0]?.score ?? 0;
  const weakNote = best < 0.55
    ? "주의: 검색된 조각의 유사도가 낮습니다. 질문과 완전히 맞는 근거가 아닐 수 있으니, 근거에 있는 내용만 짧게 답하고 자료에 없는 부분은 없다고 말합니다."
    : "자료에 근거한 내용만 답하고, 자료에 없으면 없다고 말합니다.";
  return [
    "다음 자료는 서울 맛집 정보에서 뽑은 조각입니다.",
    weakNote,
    "근거가 된 조각의 [ID]를 답 안에서 표시합니다.",
    `현재 시각은 ${now}(한국 표준시 KST)입니다. '지금', '오늘', '이번 주' 같은 상대 표현은 이 시각을 기준으로 해석합니다.`,
    "",
    "[자료]",
    context,
    "",
    "[질문]",
    question,
  ].join("\n");
}
