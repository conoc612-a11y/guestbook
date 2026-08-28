export interface RubricScore {
  id: "grounded" | "noHalluc" | "cited";
  name: string;
  score: number;
  comment: string;
}

export interface JudgeResult {
  grounded: boolean;
  noHalluc: boolean;
  cited: boolean;
  refusal: boolean;
  score: number;
  comment: string;
  rubrics: RubricScore[];
}

export const RUBRICS: { id: RubricScore["id"]; name: string; criterion: string }[] = [
  {
    id: "grounded",
    name: "근거 충실성",
    criterion:
      "답변의 모든 사실 주장이 [근거자료]에서 나왔는가. 근거와 무관하거나 모순되는 주장이 섞일수록 감점.",
  },
  {
    id: "noHalluc",
    name: "환각 통제",
    criterion:
      "[근거자료]에 없는 정보(날짜·숫자·이름·규칙)를 지어내지 않았는가. 지어낸 내용이 하나라도 있으면 0에 가깝게.",
  },
  {
    id: "cited",
    name: "출처 표시",
    criterion:
      "답변 안에 근거 조각의 [ID] 표시가 있는가. 주장마다 표시했으면 100, 일부만이면 그 비율, 없으면 0.",
  },
];

export function buildRubricPrompt(
  rubric: (typeof RUBRICS)[number],
  question: string,
  sources: string,
  answer: string,
): string {
  return [
    "당신은 RAG 챗봇 답변의 평가자입니다. 아래 [질문], [근거자료], [답변]을 읽고 다음 기준 하나만으로 채점합니다.",
    `기준 (${rubric.name}): ${rubric.criterion}`,
    "이 기준 외의 다른 품질(문체, 완결성 등)은 보지 않습니다.",
    "score: 0-100 정수, comment: 한 문장 평어(한국어)",
    '출력 형식: {"score":0,"comment":"..."} — JSON 외 텍스트 금지.',
    "",
    `[질문] ${question}`,
    "",
    `[근거자료] ${sources}`,
    "",
    `[답변] ${answer}`,
  ].join("\n");
}

export function buildRefusalPrompt(question: string, sources: string, answer: string): string {
  return [
    "아래 [질문], [근거자료], [답변]을 읽고 판정합니다.",
    "refusal: [근거자료]에 답이 없어서 답변이 '없다/찾을 수 없다'고 답한 경우 true, 그 외 false.",
    '출력 형식: {"refusal":false} — JSON 외 텍스트 금지.',
    "",
    `[질문] ${question}`,
    "",
    `[근거자료] ${sources}`,
    "",
    `[답변] ${answer}`,
  ].join("\n");
}

function to100(raw: unknown): number {
  let s = typeof raw === "number" ? raw : 0;
  if (s <= 5) s = (s / 5) * 100;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function parseJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("평가 JSON 파싱 실패");
  return JSON.parse(m[0]) as Record<string, unknown>;
}

export async function judgeAll(
  question: string,
  sources: string,
  answer: string,
  call: (prompt: string) => Promise<string>,
): Promise<JudgeResult> {
  const rubricJobs = RUBRICS.map(async (r) => {
    const j = parseJson(await call(buildRubricPrompt(r, question, sources, answer)));
    return { id: r.id, name: r.name, score: to100(j.score), comment: String(j.comment ?? "") } as RubricScore;
  });
  const refusalJob = (async () => {
    const j = parseJson(await call(buildRefusalPrompt(question, sources, answer)));
    return j.refusal === true;
  })();

  const [rubrics, refusal] = await Promise.all([Promise.all(rubricJobs), refusalJob]);

  const score = Math.round(rubrics.reduce((a, r) => a + r.score, 0) / rubrics.length);
  const weakest = [...rubrics].sort((a, b) => a.score - b.score)[0];
  return {
    grounded: rubrics.find((r) => r.id === "grounded")!.score >= 70,
    noHalluc: rubrics.find((r) => r.id === "noHalluc")!.score >= 70,
    cited: rubrics.find((r) => r.id === "cited")!.score >= 70,
    refusal,
    score,
    comment: weakest.comment,
    rubrics,
  };
}
