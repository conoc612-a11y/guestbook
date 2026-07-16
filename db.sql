-- ============================================================
--  방명록 DB 스키마  (Supabase 대시보드 > SQL Editor 에 붙여넣고 실행)
--  [로그인 버전] 글에 작성자(user_id)를 함께 저장합니다.
-- ============================================================

-- 1) 테이블
create table messages (
  id           bigint generated always as identity primary key,
  content      text not null check (char_length(content) <= 500),   -- 백엔드 검증(길이 제한)
  user_id      uuid not null references auth.users(id) on delete cascade,  -- 작성자(로그인 사용자)
  author_email text,                                                 -- 화면 표시용 이메일
  created_at   timestamptz default now()
);

-- 2) 행 수준 보안(RLS) 켜기
--    정책을 만들지 않으면 anon(브라우저)은 접근이 막힙니다.
--    우리 구조에서는 그게 정답:
--      브라우저 → (직접 접근 막힘)
--      브라우저 → Render 백엔드 → service_role 키(RLS 우회) → DB  ✅
--    "누가 무엇을 할 수 있는지"(인가)는 백엔드 코드(server.js)가 책임집니다:
--      - 쓰기: 로그인한 사용자만
--      - 삭제: 글의 user_id 와 로그인 사용자가 같을 때만
alter table messages enable row level security;
