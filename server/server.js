// ============================================================
//  방명록 백엔드 API  (Render 배포용, Node + Express)
//  - 브라우저(index.html)는 이 서버만 호출합니다.
//  - 실제 DB(Supabase) 접근은 오직 여기(서버)에서만 일어납니다.
//  - Supabase "service_role"(비밀) 키가 브라우저에 노출되지 않습니다.
//
//  [로그인 추가] 쓰기/삭제는 로그인한 사용자만 가능합니다.
//   흐름: 브라우저가 Google 로그인으로 받은 JWT 토큰을
//         Authorization: Bearer <토큰> 헤더로 보내면,
//         서버가 그 토큰을 검증해 "누구인지" 확인합니다.
//
//  코드를 [1]~[7] 순서로 뜯어보세요.
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

// ---- [3] 로그인 확인 헬퍼 (인증) ----
//  요청 헤더의 "Authorization: Bearer <토큰>" 을 꺼내서 Supabase에 검증을 맡깁니다.
//  올바른 토큰이면 사용자 정보(id, email)를 돌려주고, 아니면 null.
async function getUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token); // 토큰 위조/만료 검사
  if (error || !data?.user) return null;
  return data.user;
}

// ---- [4] READ: 목록 불러오기 (로그인 없이 누구나) ----
//  user_id / author_email 도 함께 내려서, 프론트가 "내 글"만 삭제 버튼을 보이게 합니다.
app.get('/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content, author_email, user_id, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- [5] CREATE: 새 글 저장 (로그인 필요) ----
app.post('/messages', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' }); // 인증

  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  if (content.length > 500) return res.status(400).json({ error: '500자 이하로 작성하세요.' });

  const { data, error } = await supabase
    .from('messages')
    .insert({ content, user_id: user.id, author_email: user.email }) // 작성자 기록
    .select('id, content, author_email, user_id, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ---- [6] DELETE: 글 삭제 (로그인 필요 + "내 글만") ----
app.delete('/messages/:id', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' }); // 인증

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 id 입니다.' });

  // 먼저 그 글의 주인이 누구인지 확인 (인가)
  const { data: row, error: e1 } = await supabase
    .from('messages').select('user_id').eq('id', id).single();
  if (e1 || !row) return res.status(404).json({ error: '글을 찾을 수 없습니다.' });
  if (row.user_id !== user.id) {
    return res.status(403).json({ error: '본인 글만 삭제할 수 있습니다.' }); // 인가 거부
  }

  const { error } = await supabase.from('messages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// ---- [7] 헬스체크 + 서버 시작 ----
app.get('/', (req, res) => res.type('text').send('guestbook api ok'));

const port = PORT || 3000;
app.listen(port, () => console.log(`✅ 방명록 API 실행 중: 포트 ${port}`));
