# 방명록 (3계층: GitHub Pages + Render + Supabase)

글을 남기면 **백엔드(Render)** 를 거쳐 **DB(Supabase)** 에 저장되는 방명록입니다.
**프론트엔드(GitHub Pages)** 는 DB에 직접 접근하지 않고 백엔드 API만 호출합니다.
(로그인 없는 공개 방명록 — 누구나 읽기/쓰기/삭제)

```
[브라우저 index.html]  ──fetch──▶  [Render 백엔드 API]  ──service_role──▶  [Supabase DB]
     (GitHub Pages)                    (Node/Express)                       (Postgres)
     비밀값 없음                      비밀 키는 여기 환경변수에만              RLS로 잠금(백엔드만 접근)
```

## 폴더 구조
```
guestbook/
├─ index.html        # 프론트엔드 (GitHub Pages 에 올림)
├─ db.sql            # DB 스키마 (Supabase SQL Editor 에서 실행)
├─ README.md
└─ server/           # 백엔드 (Render 에 올림)
   ├─ server.js
   ├─ package.json
   ├─ .env.example   # 환경변수 템플릿 (.env 는 깃에 안 올라감)
   └─ .gitignore
```

## 배포 순서

### 1) Supabase — DB 만들기
1. supabase.com 에서 프로젝트 생성.
2. **SQL Editor** 에 [`db.sql`](db.sql) 내용을 붙여넣고 실행.
3. **Project Settings → API (API Keys)** 에서 두 값 확인:
   - **Project URL**
   - **service_role** 키 (⚠️ secret — 절대 프론트/깃허브 금지, Render 에만)

### 2) Render — 백엔드 배포하기
1. 이 저장소를 GitHub 에 올린 뒤 Render 에서 **New → Web Service** 로 연결.
2. 설정:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
3. **Environment** 탭에 환경변수 입력 ([`server/.env.example`](server/.env.example) 참고):
   - `SUPABASE_URL` = (1번의 Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` = (1번의 service_role 키)
   - `ALLOWED_ORIGIN` = 프론트 주소 (예: `https://conoc612-a11y.github.io`) — 모르면 `*` 로 뒀다가 나중에 좁히기
4. 배포되면 주소를 받습니다. 예: `https://guestbook-api-xxxx.onrender.com`

### 3) 프론트엔드 — Render 주소 연결 + GitHub Pages 배포
1. [`index.html`](index.html) 의 `[1]` 부분 `API_BASE_URL` 을 Render 주소로 교체 (끝에 `/` 없이).
2. 저장소 **Settings → Pages → Source** 를 `Deploy from a branch` → `main` / `/root` 로 지정.
3. 1~2분 뒤 `https://<아이디>.github.io/<리포>/` 로 접속.

### 4) 제출 전 확인
- 무료 Supabase/Render 는 방치 시 잠들 수 있으니, 시연 직전 둘 다 깨어있는지 확인.
- Render 무료 플랜은 첫 요청 시 깨어나느라 몇십 초 걸릴 수 있음(콜드 스타트).

## 로컬에서 먼저 돌려보기 (선택)
```bash
cd server
npm install
cp .env.example .env      # .env 에 실제 값 채우기
npm run dev               # http://localhost:3000
```
그리고 `index.html` 의 `API_BASE_URL` 을 `http://localhost:3000` 으로 잠깐 바꿔서 브라우저로 열면 됩니다.

## 보안 체크
- ✅ **비밀 키 분리**: `service_role` 키는 Render 환경변수에만. 프론트/깃허브엔 없음.
- ✅ **백엔드 검증**: 글 길이 제한을 서버(`server.js`)와 DB(`CHECK` 제약) 양쪽에서 검사.
- ✅ **XSS 방지**: 사용자 글은 `innerHTML` 이 아니라 `textContent` 로 렌더링.
- ✅ **DB 잠금**: RLS 켜고 정책 없음 → 브라우저 직접 접근 불가, 백엔드만 접근.

## 개선 기능 (과제 제출용)
- **삭제 기능 구현됨**: 각 글의 🗑 버튼 → 백엔드 `DELETE /messages/:id` → DB 삭제.
- 제출 한 줄 예: "글 삭제 기능 추가 (프론트 삭제 버튼 + 백엔드 DELETE 엔드포인트)".
