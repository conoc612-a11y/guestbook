#!/usr/bin/env python3
"""
검색 유효성 검증 — 같은 임베딩 모델로 질문을 임베딩해
청크 벡터스토어와 코사인 유사도 검색이 관련 청크를 찾는지 확인.
브라우저 src/rag.ts retrieve() 의 코사인 검색과 같은 로직.
"""
import json, math, sys
from pathlib import Path
import numpy as np
import onnxruntime as ort

def embed(embedder, tokenizer, text):
    import numpy as np
    tok = tokenizer(text, return_tensors="np", padding=True, truncation=True, max_length=512)
    input_ids = tok["input_ids"].astype(np.int64)
    attention_mask = tok["attention_mask"].astype(np.int64)
    out = embedder.run(["last_hidden_state"], {"input_ids": input_ids, "attention_mask": attention_mask})[0]
    hs, am = out[0], attention_mask[0]
    hid = hs.shape[1]
    acc = np.zeros(hid, dtype=np.float64)
    cnt = 0
    for s in range(hs.shape[0]):
        w = float(am[s]); cnt += w
        if not w: continue
        acc += hs[s] * float(w)
    acc /= cnt
    n = math.sqrt(float(np.dot(acc, acc)))
    return (acc / n).tolist()

def cosine(a, b):
    return sum(x*y for x, y in zip(a, b))

def main():
    model_dir = Path(__file__).parent / ".model"
    data = json.load(open(Path(__file__).parent / "public" / "guestbook-docs.json", encoding="utf-8"))
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained("onnx-community/embeddinggemma-300m-ONNX", trust_remote_code=True)
    embedder = ort.InferenceSession(str(model_dir / "model_no_gather_q4.onnx"), providers=["CPUExecutionProvider"])

    vectors = {c["id"]: c["vector"] for c in data}
    sections = {c["id"]: c["section"] for c in data}

    queries = [
        "방명록에 글을 어떻게 남겨?",
        "방명록 글 삭제는 어떻게 해?",
        "보안은 어떻게 되나요? XSS 방지 방법",
        "배포 순서 좀 알려줘",
        "3계층 구조가 뭐야?",
        "service_role 키는 어디에 보관해?",
    ]
    print("="*70)
    for q in queries:
        qv = embed(embedder, tokenizer, q)
        scored = sorted(data, key=lambda c: cosine(c["vector"], qv), reverse=True)[:5]
        print(f"\n질문: {q}")
        for c in scored:
            print(f"  {c['id']} {c['section']:12} sim={cosine(c['vector'], qv):.4f} | {c['text'][:40]}")

if __name__ == "__main__":
    main()
