#!/usr/bin/env python3
"""
guestbook-docs.json 빌더 — 방명록 안내 지식을 청크로 분할하고
embeddinggemma-300m(ONNX, no_gather_q4)으로 768차원 벡터를 생성합니다.

브라우저의 src/rag.ts embed()와 동일한 풀링 로직
(mean pooling + L2 정규화 + attention mask 가중)을 사용해
질문 임베딩과 청크 벡터가 서로 비교 가능하도록 합니다.
"""

import json
import math
from pathlib import Path
import numpy as np
import onnxruntime as ort

MODEL_ONNX = "model_no_gather_q4.onnx"
MODEL_DATA = "model_no_gather_q4.onnx_data"
MODEL_URL = "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/main/onnx"

# ── 시드 데이터 — 방명록 안내 지식 ──────────────────────────────
# 각 항목: {title, section, text}
FACTS = [
    {
        "title": "방명록 개요",
        "section": "개요",
        "text": "방명록은 글을 남기면 백엔드(Render)를 거쳐 DB(Supabase)에 저장되는 방명록 서비스입니다. 프론트엔드(GitHub Pages)는 DB에 직접 접근하지 않고 백엔드 API만 호출합니다. 로그인 없는 공개 방명록으로 누구나 글을 읽고, 쓰고, 삭제할 수 있습니다.",
    },
    {
        "title": "3계층 아키텍처",
        "section": "아키텍처",
        "text": "방명록은 3계층 구조입니다. 첫째, 프론트엔드는 GitHub Pages에 올린 index.html로 비밀값이 없습니다. 둘째, 백엔드는 Render에 올린 Node/Express 서버로 service_role 키 같은 비밀 키를 환경변수에만 보관합니다. 셋째, DB는 Supabase의 Postgres로 RLS로 잠궈 백엔드만 접근할 수 있습니다.",
    },
    {
        "title": "주요 기능",
        "section": "기능",
        "text": "방명록의 주요 기능은 글 쓰기, 글 읽기, 글 삭제입니다. 글을 남기면 프론트에서 백엔드 API로 전달되고, 백엔드는 DB에 저장합니다. 삭제 기능은 각 글의 휴지통 버튼을 누르면 백엔드의 DELETE /messages/:id 엔드포인트가 호출되어 DB에서 삭제됩니다.",
    },
    {
        "title": "데이터 흐름",
        "section": "아키텍처",
        "text": "방명록의 데이터 흐름은 브라우저의 index.html이 fetch로 Render 백엔드 API를 호출하고, 백엔드가 service_role 키로 Supabase DB에 접근하는 구조입니다. 사용자가 글을 쓰면 [브라우저] → [Render 백엔드] → [Supabase DB] 순서로 저장됩니다.",
    },
    {
        "title": "글 쓰기",
        "section": "기능",
        "text": "방명록에 글을 쓰려면 페이지의 입력란에 내용을 작성하고 등록하면 됩니다. 백엔드는 글 길이를 서버(server.js)와 DB(CHECK 제약) 양쪽에서 검사합니다. 정상 등록되면 새 글이 목록에 추가됩니다.",
    },
    {
        "title": "글 읽기",
        "section": "기능",
        "text": "방명록의 글은 페이지를 열면 목록으로 보여집니다. 백엔드에서 GET 요청으로 DB의 messages 테이블을 조회해 화면에 렌더링합니다. 사용자 글은 innerHTML이 아니라 textContent로 렌더링해 XSS 공격을 방지합니다.",
    },
    {
        "title": "글 삭제",
        "section": "기능",
        "text": "방명록의 각 글에는 휴지통 버튼이 있어 작성된 글을 삭제할 수 있습니다. 삭제 버튼을 누르면 백엔드의 DELETE /messages/:id 엔드포인트가 호출되어 해당 id의 글을 DB에서 삭제합니다. 과제 개선 기능으로 삭제 기능이 구현되어 있습니다.",
    },
    {
        "title": "보안: 비밀 키 분리",
        "section": "보안",
        "text": "방명록은 Supabase의 service_role 키를 Render 환경변수에만 보관합니다. 프론트엔드(index.html)와 GitHub 저장소에는 비밀 키가 절대 포함되지 않습니다. 이렇게 해서 클라이언트에서 비밀 키가 노출되는 것을 막습니다.",
    },
    {
        "title": "보안: XSS 방지",
        "section": "보안",
        "text": "방명록은 사용자가 입력한 글을 화면에 표시할 때 innerHTML이 아니라 textContent로 렌더링합니다. 이렇게 하면 악성 스크립트가 포함된 글을 입력해도 브라우저에서 실행되지 않아 XSS(크로스 사이트 스크립팅) 공격을 방지합니다.",
    },
    {
        "title": "보안: RLS로 DB 잠금",
        "section": "보안",
        "text": "방명록의 Supabase DB는 RLS(Row Level Security)를 켜고 정책을 만들지 않아 브라우저에서 직접 접근할 수 없습니다. service_role 키를 가진 백엔드만 DB에 접근할 수 있어, 외부에서 DB를 직접 조작할 수 없습니다.",
    },
    {
        "title": "보안: 백엔드 검증",
        "section": "보안",
        "text": "방명록은 글 길이 제한을 서버(server.js)와 DB(CHECK 제약) 양쪽에서 검사합니다. 이중 검증으로 지나치게 긴 글이나 규칙에 맞지 않는 입력이 저장되는 것을 막습니다.",
    },
    {
        "title": "Supabase DB 만들기",
        "section": "배포",
        "text": "방명록 배포 순서입니다. 1단계: supabase.com에서 프로젝트를 생성하고 SQL Editor에 db.sql 내용을 붙여넣어 실행합니다. 2단계: Project Settings의 API에서 Project URL과 service_role 키를 확인합니다. service_role 키는 secret이라 프론트나 GitHub에 올리면 안 되고 Render에만 넣습니다.",
    },
    {
        "title": "Render 백엔드 배포",
        "section": "배포",
        "text": "방명록 배포 2단계: Render에서 New Web Service로 이 저장소를 연결합니다. Root Directory를 server로 하고 Build Command는 npm install, Start Command는 npm start입니다. Environment 탭에 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN을 입력합니다.",
    },
    {
        "title": "GitHub Pages 프론트 배포",
        "section": "배포",
        "text": "방명록 배포 3단계: index.html의 API_BASE_URL을 Render 주소(끝에 / 없이)로 교체합니다. 저장소 Settings의 Pages에서 Source를 Deploy from a branch, main 브랜치 /root로 지정합니다. 1~2분 뒤 https://아이디.github.io/guestbook/으로 접속합니다.",
    },
    {
        "title": "로컬 실행",
        "section": "사용법",
        "text": "방명록을 로컬에서 먼저 돌려보려면: cd server, npm install, cp .env.example .env, .env에 실제 값을 채우고 npm run dev로 실행합니다. 그리고 index.html의 API_BASE_URL을 http://localhost:3000으로 잠깐 바꿔 브라우저로 열면 됩니다.",
    },
    {
        "title": "DB 스키마",
        "section": "DB",
        "text": "방명록의 DB는 Supabase Postgres이며 db.sql에 스키마가 정의되어 있습니다. 글을 저장하는 messages 테이블이 있고, RLS가 켜져 있어 백엔드만 접근할 수 있습니다. 글의 길이 등은 CHECK 제약으로 검사됩니다.",
    },
    {
        "title": "API 엔드포인트",
        "section": "API",
        "text": "방명록 백엔드는 Node/Express 기반의 REST API로 동작합니다. 글 목록 조회(GET /messages), 글 등록(POST /messages), 글 삭제(DELETE /messages/:id) 엔드포인트를 제공합니다. 모든 요청은 백엔드를 거쳐 Supabase DB에 접근합니다.",
    },
    {
        "title": "제출 전 확인",
        "section": "배포",
        "text": "방명록 제출 전 확인 사항: 무료 Supabase와 Render는 방치하면 잠들 수 있으므로 시연 직전에 둘 다 깨어있는지 확인합니다. Render 무료 플랜은 첫 요청 시 콜드 스타트로 몇십 초가 걸릴 수 있습니다.",
    },
    {
        "title": "로그인 제거",
        "section": "개요",
        "text": "방명록은 공개 방명록으로 로그인 기능이 제거되었습니다. 누구나 별도의 로그인 없이 글을 읽고, 쓰고, 삭제할 수 있습니다. 이전에는 Google 로그인이 있었지만 공개 서비스로 되돌리면서 제거되었습니다.",
    },
]


def make_chunks():
    """청크 생성 — 근거 지식 항목별로 청크화"""
    chunks = []

    # 메인 안내 청크
    chunks.append({
        "id": "GB-001",
        "section": "방명록 안내",
        "url": "https://conoc612-a11y.github.io/guestbook",
        "text": "방명록 안내는 GitHub Pages + Render + Supabase로 만든 3계층 방명록 서비스의 기능, 아키텍처, 보안, 배포 방법을 안내하는 챗봇입니다. 방명록에 글을 남기는 방법, 삭제 방법, 백엔드와 DB 구조, 보안 원칙, 배포 순서에 대해 물어보세요."
    })

    # 근거 항목별 청크
    for i, f in enumerate(FACTS):
        chunks.append({
            "id": f"GB-{i+2:03d}",
            "section": f["section"],
            "url": "https://conoc612-a11y.github.io/guestbook",
            "text": f"{f['title']}: {f['text']}"
        })

    # 테마별 요약 청크
    themes = [
        ("보안 원칙", "보안", ["비밀 키 분리", "XSS 방지", "RLS", "백엔드 검증"]),
        ("배포 순서", "배포", ["Supabase DB", "Render 백엔드", "GitHub Pages", "API_BASE_URL"]),
        ("주요 기능", "기능", ["글 쓰기", "글 읽기", "글 삭제", "휴지통 버튼"]),
    ]
    for theme_name, section, items in themes:
        text = f"{theme_name} 요약: " + ", ".join(items) + "."
        chunks.append({
            "id": f"GB-{len(chunks)+1:03d}",
            "section": section,
            "url": "https://conoc612-a11y.github.io/guestbook",
            "text": text
        })

    # 아키텍처 다이어그램 설명
    chunks.append({
        "id": f"GB-{len(chunks)+1:03d}",
        "section": "아키텍처",
        "url": "https://conoc612-a11y.github.io/guestbook",
        "text": "방명록의 동작 구조: [브라우저 index.html] —fetch→ [Render 백엔드 API] —service_role→ [Supabase DB]. 프론트엔드(GitHub Pages)엔 비밀값이 없고, 비밀 키는 Render 환경변수에만, DB는 RLS로 잠겨 백엔드만 접근합니다."
    })

    return chunks



class Embedder:
    """embeddinggemma-300m ONNX 임베더 — rag.ts 브라우저와 동일한 풀링"""
    def __init__(self, model_dir: Path):
        self.tokenizer = None
        self.session = ort.InferenceSession(
            str(model_dir / MODEL_ONNX),
            providers=["CPUExecutionProvider"],
        )
        # 토큰나이저 (transformers)
        from transformers import AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(
            "onnx-community/embeddinggemma-300m-ONNX",
            trust_remote_code=True,
        )

    def embed(self, text: str) -> list:
        tok = self.tokenizer(
            text,
            return_tensors="np",
            padding=True,
            truncation=True,
            max_length=512,
        )
        input_ids = tok["input_ids"].astype(np.int64)
        attention_mask = tok["attention_mask"].astype(np.int64)
        out = self.session.run(
            ["last_hidden_state"],
            {"input_ids": input_ids, "attention_mask": attention_mask},
        )[0]
        hs = out[0]                # [seq, hid]
        am = attention_mask[0]     # [seq]
        hid = hs.shape[1]
        acc = np.zeros(hid, dtype=np.float64)
        cnt = 0
        for s in range(hs.shape[0]):
            w = float(am[s])
            cnt += w
            if not w:
                continue
            acc += hs[s] * w
        acc /= cnt
        norm = math.sqrt(float(np.dot(acc, acc)))
        vec = (acc / norm).tolist()
        return [round(float(v), 5) for v in vec]


def download_model(model_dir: Path):
    """ONNX 모델 파일 다운로드 (없으면)"""
    import urllib.request
    model_dir.mkdir(exist_ok=True)
    for fn in (MODEL_ONNX, MODEL_DATA):
        target = model_dir / fn
        if target.exists():
            continue
        url = f"{MODEL_URL}/{fn}"
        print(f"  다운로드: {fn} ({'~200MB' if 'data' in fn else '~20MB'})…")
        urllib.request.urlretrieve(url, str(target))
        print(f"  ✓ {fn}")


def build():
    chunks = make_chunks()
    model_dir = Path(__file__).parent / ".model"

    # ONNX 모델 다운로드 + 임베딩
    print("1. ONNX 모델 확인/다운로드")
    download_model(model_dir)
    print("2. 청크 임베딩 생성 (embeddinggemma-300m)")
    embedder = Embedder(model_dir)
    for i, chunk in enumerate(chunks):
        chunk["vector"] = embedder.embed(chunk["text"])
        if i == 0 or (i + 1) % 10 == 0:
            print(f"  {i+1}/{len(chunks)} 임베딩 완료")

    out_dir = Path(__file__).parent / "public"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "guestbook-docs.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False)
    print(f"3. ✓ {len(chunks)}개 청크 저장 → {out_path}")


if __name__ == "__main__":
    build()
