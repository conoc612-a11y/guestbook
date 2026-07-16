# 방명록 (3계층: GitHub Pages + Render + Supabase, Google 로그인)

글을 남기면 **백엔드(Render)** 를 거쳐 **DB(Supabase)** 에 저장되는 방명록입니다.
**프론트엔드(GitHub Pages)** 는 DB에 직접 접근하지 않고 백엔드 API만 호출합니다.
**쓰기·삭제는 Google 로그인**이 필요하며, **삭제는 본인 글만** 가능합니다(읽기는 누구나).

```
[브라우저 index.html]  ──fetch(+토큰)──▶  [Render 백엔드 API]  ──service_role──▶  [Supabase DB]
     (GitHub Pages)                          (Node/Express)                       (Postgres)
  anon 키로 Google 로그인만              토큰 검증 + 작성자 확인               RLS로 잠금(백엔드만 접근)
  (비밀 키는 없음)                       (비밀 키는 여기 환경변수에만)
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
3. **Project Settings → API** 에서 세 값 확인:
   - **Project URL**
   - **anon (publishable)** 키 — 프론트에 넣음(공개돼도 안전)
   - **service_role** 키 (⚠️ secret — 절대 프론트/깃허브 금지, Render 에만)

### 2) Google 로그인 설정 (OAuth)
1. **Google Cloud Console** (console.cloud.google.com):
   - **API 및 서비스 → OAuth 동의 화면** 구성(외부, 앱 이름/이메일 정도).
   - **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 웹 애플리케이션**.
   - **승인된 리디렉션 URI** 에 아래를 추가 (Supabase 콜백 주소):
     `https://<프로젝트ref>.supabase.co/auth/v1/callback`
   - 만들면 **클라이언트 ID** 와 **클라이언트 보안 비밀** 을 받습니다.
2. **Supabase 대시보드 → Authentication → Providers → Google**:
   - 사용 설정 후 위 **클라이언트 ID / 보안 비밀** 붙여넣기.
3. **Supabase → Authentication → URL Configuration**:
   - **Site URL** 과 **Redirect URLs** 에 프론트 주소를 추가
     (예: `https://내아이디.github.io/guestbook/`, 로컬 테스트 시 `http://localhost:3000` 도).

### 3) Render — 백엔드 배포하기
1. 이 저장소를 GitHub 에 올린 뒤 Render 에서 **New → Web Service** 로 연결.
2. 설정:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
3. **Environment** 탭에 환경변수 입력 ([`server/.env.example`](server/.env.example) 참고):
   - `SUPABASE_URL` = (1번의 Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` = (1번의 service_role 키)
   - `ALLOWED_ORIGIN` = 프론트 주소 (예: `https://내아이디.github.io`) — 모르면 `*` 로 뒀다가 나중에 좁히기
4. 배포되면 주소를 받습니다. 예: `https://guestbook-api-xxxx.onrender.com`

### 4) 프론트엔드 — 값 3개 넣고 GitHub Pages 배포
1. [`index.html`](index.html) 의 `[1]` 부분 세 상수를 본인 값으로 교체:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon(publishable) 키
   - `API_BASE_URL` = Render 주소 (끝에 `/` 없이)
2. 저장소 **Settings → Pages → Source** 를 `Deploy from a branch` → `main` / `/root` 로 지정.
3. 1~2분 뒤 `https://<아이디>.github.io/<리포>/` 로 접속.

### 5) 제출 전 확인
- 무료 Supabase/Render 는 방치 시 잠들 수 있으니, 시연 직전 둘 다 깨어있는지 확인.
- Render 무료 플랜은 첫 요청 시 깨어나느라 몇십 초 걸릴 수 있음(콜드 스타트).

## 로컬에서 먼저 돌려보기 (선택)
```bash
cd server
npm install
cp .env.example .env      # .env 에 실제 값 채우기
npm run dev               # http://localhost:3000
```
그리고 `index.html` 의 `API_BASE_URL` 을 `http://localhost:3000` 으로 잠깐 바꿔서 열면 됩니다.
(로컬에서 Google 로그인까지 테스트하려면 위 2)의 Redirect URLs 에 `http://localhost:3000` 도 넣어야 합니다.)

## 보안 체크
- ✅ **비밀 키 분리**: `service_role` 키는 Render 환경변수에만. 프론트/깃허브엔 anon 키(공개용)만.
- ✅ **인증**: 쓰기/삭제 시 Google 로그인 토큰(JWT)을 서버가 검증.
- ✅ **인가**: 삭제는 글의 `user_id` 와 로그인 사용자가 같을 때만 허용(서버에서 검사).
- ✅ **백엔드 검증**: 글 길이 제한을 서버(`server.js`)와 DB(`CHECK` 제약) 양쪽에서 검사.
- ✅ **XSS 방지**: 사용자 글은 `innerHTML` 이 아니라 `textContent` 로 렌더링.
- ✅ **DB 잠금**: RLS 켜고 정책 없음 → 브라우저 직접 접근 불가, 백엔드만 접근.

## 개선 기능 (과제 제출용)
- **로그인(인증) + 내 글만 삭제(인가)** 구현됨.
- 제출 한 줄 예: "Google 로그인 추가 + 로그인 사용자만 글쓰기, 본인 글만 삭제(백엔드에서 토큰 검증·소유자 확인)".
