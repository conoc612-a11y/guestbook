import { useState, useRef, useEffect, type CSSProperties } from "react";
import { retrieve, buildPrompt, loadCorpus, onEmbedProgress, peekModelCache, type Retrieved } from "./rag";
import { chatStream, pingOllama, judgeWithOllama, type ChatMsg } from "./ollama";
import { geminiStream, judgeTurn } from "./gemini";
import type { JudgeResult } from "./judge";

interface Turn {
  role: "user" | "assistant";
  content: string;
  sources?: Retrieved[];
  question?: string;
  judge?: JudgeResult;
  judgeError?: boolean;
  feedback?: "up" | "down";
  judgeBy?: "qwen3.5:2b" | "gemini-3.5-flash";
}

type Phase = "idle" | "embed" | "search" | "stream" | "error-ollama";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  embed: "① 질문 임베딩 중 — 브라우저에서 질문을 벡터로 바꿉니다",
  search: "② 근거 검색 중 — 벡터 유사도 + BM25 하이브리드 검색",
  stream: "③ 답변 생성 중 — 찾은 근거를 붙여 모델이 답을 씁니다",
  "error-ollama": "연결 실패",
};

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([
    {
      role: "assistant",
      content:
        "안녕하세요. 방명록 안내 챗봇입니다. 방명록에 글을 남기는 방법, 삭제, 3계층 구조, 보안 원칙, 배포 순서 등에 대해 무엇이든 물어보세요. 답은 공개 데이터에서 뽑은 근거로만 드립니다.",
    },
  ]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [engine, setEngine] = useState<"local" | "gemini">("local");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("guestbook_gemini_key") ?? "");
  const [showSource, setShowSource] = useState<Retrieved[] | null>(null);
  const [lastHits, setLastHits] = useState<Retrieved[] | null>(null);
  const [dlPct, setDlPct] = useState<number | null>(null);
  const [judgeBusy, setJudgeBusy] = useState(false);
  const [openSrc, setOpenSrc] = useState<Record<number, boolean>>({});
  const [hitsOpen, setHitsOpen] = useState(false);
  const [embedCached, setEmbedCached] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pingOllama().then(setOllamaOk);
    loadCorpus().catch(() => undefined);
    peekModelCache().then(setEmbedCached);
    onEmbedProgress((p) => {
      if (p.cached) setEmbedCached(true);
      setDlPct(p.pct >= 100 ? null : p.pct);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, phase]);

  async function ask() {
    const q = input.trim();
    if (!q || phase !== "idle") return;
    setInput("");
    setTurns((t) => [...t, { role: "user", content: q }]);

    let streamStarted = false;
    try {
      setPhase("embed");
      await new Promise((r) => setTimeout(r, 350));
      setPhase("search");
      const hits = await retrieve(q, 15);
      setDlPct(null);
      setLastHits(hits);
      setHitsOpen(false);
      await new Promise((r) => setTimeout(r, 450));
      const prompt = buildPrompt(q, hits);
      const messages: ChatMsg[] = [
        {
          role: "system",
          content:
            "당신은 방명록 안내 도우미입니다. 주어진 자료에 근거한 내용만 답하고, 자료에 없는 정보는 '제가 가진 자료에는 없습니다'라고 답합니다. 근거 조각의 [ID]를 답에 표시합니다. 사용자가 보낸 현재 시각(KST)을 기준으로 '지금', '오늘', '이번 주' 같은 시간 표현을 해석합니다.",
        },
        { role: "user", content: prompt },
      ];

      const lastQ = q;
      setTurns((t) => [...t, { role: "assistant", content: "", sources: hits, question: lastQ }]);
      setPhase("stream");
      streamStarted = true;
      abortRef.current = new AbortController();
      let acc = "";
      const onPiece = (piece: string) => {
        acc += piece;
        setTurns((t) => {
          const copy = [...t];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: acc, sources: hits };
          return copy;
        });
      };
      if (engine === "gemini") {
        await geminiStream(
          [
            { role: "user", text: messages[0].content },
            { role: "user", text: messages[1].content },
          ],
          apiKey,
          onPiece,
          abortRef.current.signal,
        );
      } else {
        await chatStream(messages, onPiece, "qwen3.5:2b", abortRef.current.signal);
      }
      setPhase("idle");

      setJudgeBusy(true);
      try {
        const src = hits.map((h) => `[${h.chunk.id}] ${h.chunk.text}`).join("\n");
        const by = engine === "gemini" && apiKey ? "gemini-3.5-flash" as const : "qwen3.5:2b" as const;
        const verdict =
          engine === "gemini" && apiKey
            ? await judgeTurn(lastQ, src, acc, apiKey)
            : await judgeWithOllama(lastQ, src, acc);
        setTurns((t) => {
          const copy = [...t];
          const li = copy.length - 1;
          copy[li] = { ...copy[li], judge: verdict, judgeBy: by };
          return copy;
        });
      } catch {
        setTurns((t) => {
          const copy = [...t];
          const li = copy.length - 1;
          copy[li] = { ...copy[li], judgeError: true };
          return copy;
        });
      } finally {
        setJudgeBusy(false);
      }
    } catch (e: unknown) {
      console.error("챗봇 파이프라인 오류:", e);
      setDlPct(null);
      const msg = e instanceof Error ? e.message : String(e);
      if (!streamStarted) {
        setTurns((t) => [
          ...t.filter((x) => x.content !== ""),
          { role: "assistant", content: `⚠ 답변을 만들지 못했습니다 — ${msg}` },
        ]);
        setPhase("idle");
        return;
      }
      setPhase("error-ollama");
      setOllamaOk(false);
      setTurns((t) => [
        ...t.filter((x) => x.content !== ""),
        { role: "assistant", content: "⚠ 로컬 모델(ollama)에 연결하지 못했습니다 — 페이지 위 안내를 따라 ollama를 실행·설정한 뒤 다시 질문해 주세요." },
      ]);
      setPhase("idle");
    }
  }

  function stop() {
    abortRef.current?.abort();
    setPhase("idle");
  }

  function setFeedback(i: number, v: "up" | "down") {
    setTurns((t) => {
      const copy = [...t];
      copy[i] = { ...copy[i], feedback: copy[i].feedback === v ? undefined : v };
      return copy;
    });
    console.log("feedback", { turn: i, value: v });
  }

  const nBm = lastHits ? lastHits.filter((h) => h.method === "bm25").length : 0;

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-inner">
          <p className="hero-badge">방명록 안내 · RAG 챗봇</p>
          <h1>방명록 안내 <span className="accent">Guestbook</span></h1>
          <p className="hero-sub">
            방명록의 기능·구조·보안·배포를 근거 기반으로 안내합니다.
            로컬 모델이 공개 데이터에서 근거를 찾아 답합니다.
          </p>
          <a className="hero-cta" href="#chat">챗봇으로 물어보기 ↓</a>
        </div>
      </header>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((g) => (
            <div className="marquee-group" key={g}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i}>GUESTBOOK GUIDE <i>∞</i></span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <section className="engine">
        <div className="engine-row">
          <span>답변 엔진:</span>
          <label><input type="radio" checked={engine==="local"} onChange={()=>setEngine("local")} /> 로컬 ollama (qwen3.5:2b)</label>
          <label><input type="radio" checked={engine==="gemini"} onChange={()=>setEngine("gemini")} /> Gemini API</label>
        </div>
        {engine === "gemini" && (
          <div className="engine-row">
            <input
              type="password"
              placeholder="Gemini API 키 (브라우저에만 저장됩니다)"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); localStorage.setItem("guestbook_gemini_key", e.target.value); }}
            />
          </div>
        )}
      </section>

      {ollamaOk === false && engine === "local" && (
        <div className="banner">
          <strong>로컬 모델(ollama)에 연결할 수 없습니다.</strong>
          <ol>
            <li><code>ollama serve</code> 실행 (또는 Ollama 앱 실행) · 모델 확인: <code>ollama pull qwen3.5:2b</code></li>
            <li>
              CORS 허용 — 운영 체제별로 한 번만 설정하고 Ollama를 재시작합니다:
              <div className="os-guide">
                <div><strong>Windows</strong> 작업 표시줄에서 Ollama를 종료합니다. 설정에서 <code>환경 변수</code>를 검색해 <code>계정의 환경 변수 편집</code>을 열고 새 변수 <code>OLLAMA_ORIGINS</code>에 <code>https://*.github.io</code>를 넣은 뒤 Ollama를 다시 시작합니다.</div>
                <div><strong>macOS</strong> <code>launchctl setenv OLLAMA_ORIGINS "https://*.github.io"</code> 입력 후 Ollama 앱을 재시작합니다.</div>
                <div><strong>Linux</strong> <code>sudo systemctl edit ollama.service</code>에서 <code>Environment="OLLAMA_ORIGINS=https://*.github.io"</code> 추가 후 <code>sudo systemctl restart ollama</code></div>
              </div>
            </li>
          </ol>
          <button onClick={() => pingOllama().then(setOllamaOk)}>다시 확인</button>
        </div>
      )}

      <section className="info">
        <div className="card card-a">
          <h2>기능 안내</h2>
          <p>글 쓰기·읽기·삭제와 데이터 흐름을 설명합니다. 로그인 없는 공개 방명록입니다.</p>
        </div>
        <div className="card card-b">
          <h2>근거 원칙</h2>
          <p>모든 답변은 공개 데이터에서 뽑은 조각에 근거합니다. 자료에 없으면 없다고 답합니다.</p>
        </div>
        <div className="card card-c">
          <h2>실행 구조</h2>
          <p>브라우저가 직접 로컬 ollama 모델을 호출하고, 질문 임베딩도 브라우저에서 실행합니다.</p>
        </div>
      </section>

      <section id="chat" className="chat">
        <h2>
          방명록 안내 챗봇
          <span className={`conn ${ollamaOk === true ? "ok" : ollamaOk === false ? "bad" : ""}`}>
            {engine === "gemini"
              ? "Gemini API"
              : ollamaOk === true ? "ollama 연결됨" : ollamaOk === false ? "ollama 미연결" : "연결 확인 중…"}
          </span>
        </h2>
        <div className="chat-log">
          {turns.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              <div className="bubble-text">{t.content || (phase === "stream" && i === turns.length - 1 ? "…" : "")}</div>
              {t.role === "assistant" && t.question && (
                <div className="meta-row">
                  {t.judge ? (
                    <span className={`judge ${(t.judge.score ?? 0) >= 70 ? "ok" : "bad"}`}>
                      평가 {t.judge.score}점 (루브릭 평균) ·
                      {(t.judge.rubrics ?? []).map((r) => ` ${r.name} ${r.score}`).join(" ·")}
                      {t.judge.refusal ? " · 정당한 거부" : ""}
                      {t.judge.comment && <em> "{t.judge.comment}"</em>}
                      <span className="judge-by"> · 판정 {t.judgeBy === "gemini-3.5-flash" ? "gemini-3.5-flash" : "qwen3.5:2b 자기평가"}</span>
                    </span>
                  ) : t.judgeError ? (
                    <span className="judge fail">판정 실패 — 평가 모델이 결과를 만들지 못했습니다 (답변은 정상)</span>
                  ) : judgeBusy && i === turns.length - 1 ? (
                    <span className="judge">④ 판정 중… (LLM-as-a-Judge)</span>
                  ) : null}
                  <span className="feedback">
                    <button aria-label="좋아요" className={t.feedback === "up" ? "on" : ""} onClick={() => setFeedback(i, "up")}>👍</button>
                    <button aria-label="싫어요" className={t.feedback === "down" ? "on" : ""} onClick={() => setFeedback(i, "down")}>👎</button>
                  </span>
                </div>
              )}
              {t.sources && !(phase === "stream" && i === turns.length - 1) && (
                <div className="chips">
                  <button
                    className="chips-toggle"
                    onClick={() => setOpenSrc((m) => ({ ...m, [i]: !m[i] }))}
                  >
                    출처 {t.sources.length}개 {openSrc[i] ? "접기 ▴" : "펼쳐 보기 ▾"}
                  </button>
                  {t.sources[0].score < 0.55 && (
                    <span className="weak-badge">⚠ 최고 유사도 {(t.sources[0].score * 100).toFixed(1)}%</span>
                  )}
                  {openSrc[i] &&
                    t.sources.map((s) => (
                      <button
                        key={s.chunk.id}
                        className={`chip ${s.method === "bm25" ? "bm25" : "vec"}`}
                        onClick={() => setShowSource(t.sources!)}
                      >
                        {s.chunk.id} · {s.chunk.section} · {s.method === "bm25" ? "BM25" : "벡터"} {(s.score * 100).toFixed(0)}%
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
          {(phase === "embed" || phase === "search") && (
            <div className="phase-box">
              <span className="spinner" />
              <span>
                {phase === "embed" && embedCached
                  ? "① 질문 임베딩 중 — 캐시된 모델 사용 (다운로드 없음)"
                  : PHASE_LABEL[phase]}
                {dlPct !== null && (
                  <div className="dl-progress">
                    임베딩 모델을 내려받는 중 {dlPct}% — 첫 방문 1회(약 200MB), 이후 브라우저에 캐시됩니다
                  </div>
                )}
              </span>
            </div>
          )}
          {lastHits && phase === "stream" && (
            <div className="hits-box">
              <div className="hits-title">
                <button className="chips-toggle" onClick={() => setHitsOpen((o) => !o)}>
                  ② 검색된 근거 {lastHits.length}개 — 벡터 {lastHits.length - nBm} · BM25 {nBm}{" "}
                  {hitsOpen ? "접기 ▴" : "펼쳐 보기 ▾"}
                </button>
                {lastHits[0].score < 0.55 && (
                  <span className="weak-badge"> ⚠ 최고 유사도 {(lastHits[0].score * 100).toFixed(1)}% — 근거가 약합니다</span>
                )}
              </div>
              {hitsOpen &&
                lastHits.map((h) => (
                  <div key={h.chunk.id} className={`hit-row ${h.method === "bm25" ? "bm25" : "vec"}`}>
                    <span className="hit-id">{h.chunk.id}</span>
                    <span className="hit-sec">{h.chunk.section}</span>
                    <span className="hit-score" style={{ "--w": `${Math.round(h.score * 100)}%` } as CSSProperties}>
                      {h.method === "bm25" ? "BM25" : "벡터"} {(h.score * 100).toFixed(1)}%
                    </span>
                    <span className="hit-text">{h.chunk.text.slice(0, 80)}…</span>
                  </div>
                ))}
              {phase === "stream" && (
                <div className="hits-title" style={{ marginTop: hitsOpen ? ".6rem" : undefined }}>③ 이 근거로 답변을 만듭니다…</div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="chat-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="예: 매콤한 혼밥 할 수 있는 맛집 추천해줘"
            disabled={phase !== "idle"}
          />
          {phase === "stream" ? (
            <button onClick={stop} className="stop-btn">정지</button>
          ) : (
            <button onClick={ask} disabled={phase !== "idle" || !input.trim()}>
              보내기
            </button>
          )}
        </div>
      </section>

      {showSource && (
        <div className="modal" onClick={() => setShowSource(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h3>근거 조각</h3>
            {showSource.map((s) => (
              <div key={s.chunk.id} className="source-item">
                <div className="source-meta">
                  {s.chunk.id} · {s.chunk.section} · {s.method === "bm25" ? "BM25" : "벡터 유사도"} {(s.score * 100).toFixed(0)}%
                </div>
                <p>{s.chunk.text}</p>
                <a href={s.chunk.url} target="_blank" rel="noreferrer">원문 보기 →</a>
              </div>
            ))}
            <button onClick={() => setShowSource(null)}>닫기</button>
          </div>
        </div>
      )}

      <footer className="footer">
        <p>
          맛집 안내 챗봇 — 로컬 실행 데모. 자료: 서울시 공개 데이터.
          모델: qwen3.5:2b (ollama) · 임베딩: embeddinggemma-300m (브라우저).
        </p>
      </footer>
    </div>
  );
}
