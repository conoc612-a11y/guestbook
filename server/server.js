// ============================================================
//  방명록 백엔드 API  (Render 배포용, Node + Express)
//  - 브라우저(index.html)는 이 서버만 호출합니다.
//  - 실제 DB(Supabase) 접근은 오직 여기(서버)에서만 일어납니다.
//  - 그래서 Supabase "service_role"(비밀) 키가 브라우저에 노출되지 않습니다.
//  코드를 [1]~[6] 순서로 뜯어보세요.
// ============================================================

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// ---- [1] 환경변수에서 비밀값 읽기 (코드에 하드코딩 금지!) ----
const {
  SUPABASE_URL,                 // 예: https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY,    // 비밀 키 — 절대 프론트/깃허브에 넣지 말 것
  ALLOWED_ORIGIN,               // 프론트 주소 (예: https://내아이디.github.io)
  PORT,                         // Render가 자동으로 넣어줌
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  process.exit(1);
}

// ---- [2] Supabase 클라이언트 (service_role = RLS 우회, 서버 전용) ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

// ---- [3] READ: 목록 불러오기 ----
app.get('/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content, created_at')
    .order('created_at', { ascending: false }); // 최신글이 위로
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- [4] CREATE: 새 글 저장 (서버에서 검증!) ----
app.post('/messages', async (req, res) => {
  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  if (content.length > 500) return res.status(400).json({ error: '500자 이하로 작성하세요.' });

  const { data, error } = await supabase
    .from('messages')
    .insert({ content })
    .select('id, content, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ---- [5] DELETE: 글 삭제 (과제 필수 "개선 1가지") ----
app.delete('/messages/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 id 입니다.' });

  const { error } = await supabase.from('messages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end(); // 성공, 본문 없음
});

// ---- [6] 헬스체크 + 서버 시작 ----
app.get('/', (req, res) => res.type('text').send('guestbook api ok'));

const port = PORT || 3000;
app.listen(port, () => console.log(`✅ 방명록 API 실행 중: 포트 ${port}`));
