#!/usr/bin/env python3
"""
실험: 검색 세팅 변화에 따른 근거 품질 측정
- 방식: 벡터만 / 하이브리드 (벡터+BM25) / BM25만
- k (근거 개수): 5 / 10 / 15
- 평가: 관련 청크가 상위에 오는지 (Precision@k)
브라우저 src/rag.ts retrieve() 와 동일한 로직을 재현.
"""
import json, math, re, sys
from pathlib import Path

# ── rag.ts와 동일한 BM25 / 검색 로직 ──────────────────────
STOPWORDS = set("""에서 에게 한테 부터 까지 처럼 같이 마다 보다 라는 무엇 언제 어디 누구 어떤 어떻게 왜요 인가요
나요 있는 없는 하는 했던 하는지 인지 니까 이며 하고 주세요 알려줘 알려주세요 가르쳐 가르쳐줘 말해줘 해줘
해주세요 해주실 그리고 그래서 하지만 그런데 근데 the is what when where how about please tell""".split())

def query_terms(q):
    return [t for t in re.split(r'[^가-힣a-z0-9]+', q.lower()) if len(t) >= 2 and t not in STOPWORDS]

def bm25(docs, terms, k1=1.5, b=0.75):
    if not terms: return []
    toks = [query_terms(d["text"]) for d in docs]
    avgdl = sum(len(t) for t in toks) / max(len(docs), 1)
    df = {}
    for t in set(terms):
        df[t] = sum(1 for dt in toks if any(t in x for x in dt))
    out = {}
    for i, (d, dt) in enumerate(zip(docs, toks)):
        dl = max(len(dt), 1)
        score = 0
        for t, dfv in df.items():
            if not dfv: continue
            tf = sum(1 for x in dt if t in x)
            if not tf: continue
            idf = math.log((len(docs) - dfv + 0.5) / (dfv + 0.5) + 1)
            score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl))
        if score > 0:
            out[d["id"]] = score
    return out

def retrieve(data, qv, q, k, mode):
    """mode: 'vector' | 'hybrid' | 'bm25'"""
    ids = [c["id"] for c in data]
    if mode == "bm25":
        scores = bm25(data, query_terms(q))
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        return [i for i, _ in ranked[:k]]
    # 벡터 점수
    vec_scores = [(c["id"], sum(a*b for a, b in zip(c["vector"], qv))) for c in data]
    vec_rank = [i for i, _ in sorted(vec_scores, key=lambda x: -x[1])]
    if mode == "vector":
        return vec_rank[:k]
    # hybrid: 벡터 상위 10 + BM25 (중복 제외)
    top_vec = vec_rank[:min(10, k)]
    picked = set(top_vec)
    bm = bm25(data, query_terms(q))
    lex = [i for i, _ in sorted(bm.items(), key=lambda x: -x[1]) if i not in picked][:max(0, k-len(top_vec))]
    result = top_vec + lex
    for i in vec_rank:
        if i not in picked and i not in lex and len(result) < k:
            picked.add(i); result.append(i)
    return result[:k]

# ── 관련성 정답 (ground truth) ─────────────────────────────
# 각 질문에서 "정답"으로 삼을 청크 — 기능/보안/배포/구조 단원이 맞는 것
GROUND_TRUTH = {
    "방명록에 글을 남기는 방법을 알려줘": ["GB-006", "GB-004", "GB-023", "GB-002"],
    "방명록 글 삭제는 어떻게 해?": ["GB-008", "GB-004", "GB-023", "GB-018"],
    "보안은 어떻게 되어 있어? XSS 방지 방법": ["GB-010", "GB-009", "GB-021", "GB-011", "GB-012"],
    "3계층 아키텍처가 뭐야?": ["GB-003", "GB-005", "GB-024", "GB-002"],
    "배포 순서 알려줘": ["GB-013", "GB-014", "GB-015", "GB-022", "GB-019"],
    "service_role 키는 어디에 두면 돼?": ["GB-009", "GB-011", "GB-013"],
}


def main():
    data = json.load(open(Path(__file__).parent / "public" / "guestbook-docs.json", encoding="utf-8"))
    id2 = {c["id"]: c for c in data}

    # 질문 임베딩 (QR 모델 있으면, 없으면 저장된 벡터 재사용 대신 진행)
    try:
        import numpy as np
        import onnxruntime as ort
        from transformers import AutoTokenizer
        model_dir = Path(__file__).parent / ".model"
        tok = AutoTokenizer.from_pretrained("onnx-community/embeddinggemma-300m-ONNX", trust_remote_code=True)
        sess = ort.InferenceSession(str(model_dir / "model_no_gather_q4.onnx"), providers=["CPUExecutionProvider"])
        def embed(text):
            t = tok(text, return_tensors="np", padding=True, truncation=True, max_length=512)
            o = sess.run(["last_hidden_state"], {"input_ids": t["input_ids"].astype(np.int64),
                                                 "attention_mask": t["attention_mask"].astype(np.int64)})[0]
            hs, am = o[0], t["attention_mask"][0]; hid = hs.shape[1]
            acc = np.zeros(hid); cnt = 0
            for s in range(hs.shape[0]):
                w = float(am[s]); cnt += w
                if w: acc += hs[s] * float(w)
            acc /= cnt; n = math.sqrt(float(np.dot(acc, acc)))
            return (acc/n).tolist()
    except Exception as e:
        print("임베딩 모델 없음 — 랜덤 벡터로 진행", e)
        def embed(text):
            import random; random.seed(len(text))
            v = [random.gauss(0, 0.058) for _ in range(768)]
            n = math.sqrt(sum(x*x for x in v)); return [x/n for x in v]

    results = {}
    for mode in ["vector", "hybrid", "bm25"]:
        for k in [5, 10, 15]:
            hits = 0; total = 0
            for q, gt in GROUND_TRUTH.items():
                qv = embed(q)
                ranked = retrieve(data, qv, q, k, mode)
                correct = len(set(ranked) & set(gt))
                hits += correct; total += len(gt)
            results[(mode, k)] = hits/total

    # 결과 표 출력
    print("="*70)
    print("실험: 검색 세팅에 따른 근거 품질 (Precision — 관련 청크 적중률)")
    print("="*70)
    print(f"{'방식':<12} {'k=5':>10} {'k=10':>10} {'k=15':>10}")
    for mode in ["vector", "hybrid", "bm25"]:
        row = f"{mode:<12}"
        for k in [5, 10, 15]:
            row += f" {results[(mode,k)]:>9.3f}"
        print(row)

    print("\n[해석] 방식·k 에 따른 검색 품질. 하이브리드가 벡터 단독보다 정확한 표기(BM25)를 보완하는지 확인.")

if __name__ == "__main__":
    main()
