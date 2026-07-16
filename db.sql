-- ============================================================
--  방명록 DB 스키마  (Supabase 대시보드 > SQL Editor 에 붙여넣고 실행)
--  [로그인 없는 공개 버전]
-- ============================================================

-- ▶ 이미 로그인 버전 테이블을 만든 경우: 아래 "고치기" 한 번 실행하면 됩니다.
--   (user_id / author_email 컬럼 제거 → 로그인 없이 글 저장 가능)
alter table messages drop column if exists user_id;
alter table messages drop column if exists author_email;

-- ▶ 처음부터 새로 만드는 경우: 위 두 줄 대신 아래를 실행하세요.
-- create table messages (
--   id         bigint generated always as identity primary key,
--   content    text not null check (char_length(content) <= 500),  -- 백엔드 검증(길이 제한)
--   created_at timestamptz default now()
-- );
-- alter table messages enable row level security;
--   RLS 를 켜고 정책을 만들지 않으면 anon(브라우저) 은 직접 접근이 막힙니다.
--   우리 구조에서는 그게 정답:
--     브라우저 → (직접 접근 막힘)
--     브라우저 → Render 백엔드 → service_role 키(RLS 우회) → DB  ✅
