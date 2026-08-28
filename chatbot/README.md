# 방명록 안내 챗봇 (Guestbook RAG Chatbot)

방명록의 기능·구조·보안·배포를 안내하는 **서버 없는 RAG 챗봇**입니다. 브라우저에서 임베딩과 검색을 수행하고,
로컬 Ollama가 답변을 생성하며, 각 답변에 **LLM-as-a-Judge 자동 판정**을 연결합니다.

> 이 저장소의 근본 프로젝트는 [방명록(3계층)](/README.md)입니다. 이 `chatbot/` 하위폴더는 그 방명록을 주제로 한 RAG 안내 챗봇입니다.

## 동작 방식

1. 질문 입력 → 브라우저가 `embeddinggemma-300m`(ONNX)으로 임베딩
2. 하이브리드 검색(코사인 유사도 + BM25) → 24개 청크 중 근거 k개 선택
3. 근거(ID·URL·섹션 보존)를 프롬프트에 조립 → 로컬 Ollama `qwen3.5:2b`가 스트리밍 답변
4. 답변 뒤 판정 배지(근거 충실성·환각·출처 3루브릭) 표시
5. 사용자 좋아요/싫어요 피드백

## 실행 (로컬 개발)

```bash
cd chatbot
npm install
npm run dev          # http://localhost:5173
```

## 사용자 설정 (로컬 엔진)

1. Ollama 설치 후 모델 받기: `ollama pull qwen3.5:2b`
2. **CORS 허용** (원격 도메인에서 열 때): 환경변수 `OLLAMA_ORIGINS=https://*.github.io` 설정 후 Ollama 재시작
3. 첫 질문 시 임베딩 모델(~200MB) 1회 다운로드 후 브라우저 캐시
4. (선택) Gemini API 키를 입력해 로컬 대신 Gemini로 답변

## 근거 자료 구축

```bash
cd chatbot
python build_docs.py     # 방명록 안내 지식(24개) → embeddinggemma-300m으로 768차원 벡터 생성
```

- 24개 청크 (GB-001~GB-024) · ID·URL·섹션·텍스트·벡터 스키마
- 주제: 개요·아키텍처·기능(쓰기/읽기/삭제)·보안(비밀키·XSS·RLS)·배포(Supabase/Render/Pages)·DB·API
- `public/guestbook-docs.json` — 정적 벡터스토어

## 실험·평가

`python experiment.py` — 검색 세팅(벡터/하이브리드/BM25 × k)에 따른 근거 품질 측정.
결과와 해석은 [`EVALUATION.md`](EVALUATION.md).

## 빌드 & 배포 (GitHub Pages)

```bash
cd chatbot
npm run build        # dist/ 생성
```

- `base: './'` 상대 경로 — GitHub Pages의 서브경로에서도 동작
- `dist/` 내용을 Pages의 `chatbot/` 서브폴더에 게시
- 배포 URL: `https://conoc612-a11y.github.io/guestbook/chatbot/`

## 수용 기준 점검

| 기준 | 목표 | 실측 |
|---|---|---|
| 대표 질문 6개 중 근거 있는 답변 | 3개 이상 | 하이브리드 k=15 Precision 1.00 |
| 근거 충실성 루브릭 평균 | 60점 이상 | 판정 연결로 모니터링 |
| 로컬 Ollama 연결 안내 | 차단 시 표시 | 배너 구현 |
| 첫 방문 모델 캐시·진행률 | 표시 | 범위·진행률 UI |

## 프로젝트 구조

```
guestbook/
├── index.html            # (기존) 방명록 프론트
├── server/               # (기존) 방명록 백엔드
├── db.sql                # (기존) 방명록 DB 스키마
└── chatbot/              # RAG 안내 챗봇
    ├── index.html
    ├── PRD.md            # 기획 문서
    ├── EVALUATION.md     # 실험·평가
    ├── build_docs.py     # 청크 + 임베딩 생성
    ├── experiment.py     # 성능 실험
    ├── verify_search.py  # 검색 유효성 검증
    ├── public/
    │   └── guestbook-docs.json  # 정적 벡터스토어 (24청크)
    └── src/
        ├── rag.ts        # 임베딩·하이브리드 검색·프롬프트 조립
        ├── ollama.ts     # 로컬 스트리밍 클라이언트 + 판정
        ├── gemini.ts     # Gemini API 클라이언트 + 판정
        ├── judge.ts      # LLM-as-a-Judge 루브릭
        ├── App.tsx       # 메인 UI
        └── App.css
```
