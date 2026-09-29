# 작업 보고서 — 소셜 피드·검수 페이지·서버 API (MIN-122 / MIN-123 / MIN-183 / MIN-164 / MIN-144)

작성: 2026-09-29 · 브랜치 `claude/tender-wozniak-hl1shz` (PR #16 `min-122-scroll-feed` 위에 쌓음) · 머지·운영 배포·플래그 on 하지 않음

## 1. 변경 파일

| 파일 | 내용 |
|---|---|
| `api/social.js` | 공개 GET 조건을 `moderation_status = 'approved' and approved_at is not null`로 명시. 서버 플래그 `SOCIAL_ENABLED` 기본 off(404) 유지 |
| `api/_lib/admin.js` (신규) | 관리자 인증 공통: scrypt 비밀번호 해시 검증, HMAC 서명 세션 쿠키, Origin 검사, JSON 본문 파서, 로그인 시도 제한 |
| `api/admin/session.js` (신규) | 로그인(POST)·세션 확인(GET)·로그아웃(DELETE) |
| `api/admin/wishes.js` (신규) | 상태별 목록(GET)·건별 상태 변경(PATCH) |
| `admin/index.html`, `admin/admin.js`, `admin/admin.css` (신규) | 휴대폰 우선 검수 페이지 `/admin/` (분석 스크립트 없음, CSP) |
| `vercel.json` (신규) | `/admin`에 `noindex`, 프레이밍 금지, `no-store`, `no-referrer` 헤더 |
| `js/social.js` | 포커스 관리(Back 시작·더 보기/재시도 중 포커스 유지·마지막 페이지 후 새 항목으로), 2페이지 실패 재시도, `<dialog>` 미지원 대비, 바깥 클릭 닫기 제거(전체 화면이라 오작동), 열린 화면을 훅에 전달 |
| `js/main.js` | 입력 화면에서 피드를 열 때 Share 토스트를 띄우지 않도록 수정(PR #16 버그: 닫은 뒤 입력 화면에 Share가 8초 남음) |
| `index.html`, `css/style.css` | 피드 톤: 어두운 무대, 크림색, Lilita One 제목·빨간 킥커, 소원은 입력창과 같은 이탤릭·가운데 정렬·줄바꿈 유지, 항목 사이 작은 불씨 점, 상단 Back 고정. 목록 `ph-no-capture ph-mask`. 입력 화면 링크는 입력창과 함께 페이드인, 키보드가 올라오면 흐름에서 빠짐 |
| `scripts/admin/hash-password.mjs` (신규, 미배포) | `ADMIN_PASSWORD_HASH`·`ADMIN_SESSION_SECRET` 생성 |
| `scripts/dev/*` (신규, 미배포) | 로컬 서버(Neon 드라이버 → `pg` 대체), API 검사, 브라우저 흐름 검사, 이 보고서·스크린샷 |
| `README.md` | API 계약·인증·환경 변수·로컬 검사 절차, `social_feed_opened` 이벤트 |

DB 스키마는 변경·재실행하지 않았습니다.

## 2. API 계약

| 경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/social?before=<id>` | 공개 | `200 { wishes: [{ id, text }], next: id \| null }` 최신 id순 20건. `400` 잘못된 커서, `404 {status:'closed'}` 서버 플래그 off, `503` DB 없음/오류 |
| `GET /api/admin/session` | 쿠키 | `200 { authenticated: true, expires_at }` / `401 {status:'unauthorized'}` |
| `POST /api/admin/session` | `{ password }` JSON | `200` + `Set-Cookie` / `401 invalid_password` / `429 rate_limited` + `Retry-After` / `403 forbidden`(다른 Origin) / `400 invalid`(JSON 아님) |
| `DELETE /api/admin/session` | — | `200 { authenticated: false }` 쿠키 삭제 / `403` |
| `GET /api/admin/wishes?status=&before=` | 쿠키 | `200 { wishes: [{ id, text, status, created_at, reviewed_at, approved_at }], next, counts: {pending, approved, rejected, hidden} }` / `401` / `400` |
| `PATCH /api/admin/wishes` | `{ id, from, status }` JSON | `200 { wish }` 변경 / `200 { wish, unchanged: true }` 이미 그 상태(중복 클릭) / `409 { status:'conflict', wish }` 다른 곳에서 먼저 변경 / `400 invalid_transition` / `404 not_found` / `401` / `403` |

- 허용 전이: `pending → approved | rejected`, `approved → hidden`, `rejected | hidden → approved`(재검토).
- 상태 변경은 `UPDATE … SET moderation_status=$to, reviewed_at=now(), approved_at=CASE WHEN $to='approved' THEN now() ELSE NULL END WHERE id=$id AND moderation_status=$from RETURNING …` 한 문장. 원자적이며 경합 시 한 요청만 반영(아래 테스트).
- PATCH 응답에는 소원 본문을 넣지 않습니다.
- 관리자 환경 변수가 없으면 모든 관리자 경로는 `404 {status:'closed'}`.
- 401 = 로그인 안 됨/세션 만료·위조/비밀번호 틀림, 403 = 다른 Origin(CSRF) 요청.

## 3. 인증 방식·환경 변수

- 단일 관리자 비밀번호. 저장값은 scrypt 해시(`scrypt:N:r:p:salt:hash`, N=32768)뿐, 평문은 어디에도 없음.
- 세션: `__Host-oww_admin` 쿠키, `HttpOnly; Secure; SameSite=Strict; Path=/`, 12시간. 값은 `v1.<만료>.<난수>.<HMAC>`이며 키 = HMAC(`ADMIN_SESSION_SECRET`, 해시). 둘 중 하나를 바꾸면 모든 세션 무효. 로그아웃은 쿠키 삭제(무상태 토큰이라 서버측 개별 폐기는 없음 — 필요 시 시크릿 교체).
- CSRF: 상태 변경 요청은 자기 Origin(또는 `Sec-Fetch-Site: same-origin`) + `application/json` 본문 필수. 쿠키가 SameSite=Strict.
- 로그인 시도 제한: 주소당 15분 5회, 인스턴스 전체 15분 30회 실패 시 429. **함수 메모리 기반이라 인스턴스별**입니다. DB 스키마를 바꾸지 않는 조건이라 영속 저장을 쓰지 않았고, 실질 방어는 긴 무작위 비밀번호(생성기 기본 32자)+scrypt 비용입니다. 영속 제한이 필요하면 작은 `admin_login_attempts` 테이블 추가를 DB 담당에게 제안합니다.
- 로그: 오류 코드만(`admin_login_failed`, `admin_list_failed`, `admin_moderate_failed`, `social_list_failed`). 본문·비밀번호·쿠키·IP 미기록. 관리자 페이지는 PostHog를 로드하지 않음.
- 비밀값은 클라이언트 번들·URL·localStorage·Git에 없음(테스트용 로컬 비밀번호만 테스트 명령에 사용).

| 환경 변수 | 용도 |
|---|---|
| `SOCIAL_ENABLED` | `true`일 때만 공개 GET 동작(기존) |
| `ADMIN_PASSWORD_HASH` | 관리자 비밀번호의 scrypt 해시 |
| `ADMIN_SESSION_SECRET` | 세션 서명 시크릿(32자 이상) |
| `DATABASE_URL` | 기존 |

설정 절차: 로컬에서 `node scripts/admin/hash-password.mjs --generate --secret` → 출력된 두 값을 Vercel 환경 변수(우선 Preview만)에 등록 → 재배포 → `/admin/` 접속.

## 4. 테스트 환경과 결과

- 컨테이너에서 Neon 호스트로의 네트워크가 차단되어(프록시 403) **로컬 PostgreSQL 16 + `db/schema.sql`(마이그레이션 반영본)** 으로 실제 SQL을 실행했습니다. `api/` 코드는 그대로, Neon 드라이버만 `pg` 기반 대체 모듈로 바꿔 로드(`scripts/dev/server.mjs`).
- 운영 Neon(`summer-star-50391318` 기본 브랜치)은 **읽기 전용**으로만 확인: 제약·인덱스·컬럼이 로컬과 동일, 251건 전부 `pending`, `approved_at` 0건, 공개 GET 쿼리 결과 0건, 상태 변경 UPDATE는 `EXPLAIN`(실행 안 함)으로 PG 18 파싱·인덱스 사용 확인. 운영 소원을 승인·변경하지 않았고 Neon 브랜치도 만들지 않았습니다.
- 브라우저: Playwright Chromium, 390×844(터치, DPR 2)와 1280×800. 클라이언트 플래그는 테스트 브라우저 안에서만 on(`js/config.js`는 `false` 유지).

결과 원문: [`api-test.txt`](api-test.txt) **52/52 통과**, [`flow-test.txt`](flow-test.txt) **95/95 통과**.

주요 확인 항목
- 인증 없이 관리자 목록 401(본문 없음), PATCH 401, 다른 Origin PATCH/로그인/로그아웃 403, Origin 없음 403, 거부된 요청 후 DB 변경 0건.
- 로그인 쿠키 속성, 위조 쿠키·만료(서명 정상) 세션 401, 비밀번호 틀림 5회 후 429(올바른 비밀번호도 차단), 다른 주소는 로그인 가능, 로그아웃 후 401.
- 승인 → 공개 GET 노출(`id,text`만), 숨김 → 즉시 사라짐 + `approved_at NULL`·`reviewed_at` 기록, 반려 → 비노출, 숨김 → 재승인.
- 동시 승인 6건 → 1건만 반영·5건 `unchanged`; 승인·반려 동시 → 200 + 409, DB 제약 일치.
- 공개 GET 21건 이상 페이지네이션(20+5, 중복 없음), 서버 플래그 unset/false → 404, 관리자 환경 변수 없음·시크릿 32자 미만 → 404.
- 입력 화면 → 피드 → Back/Escape 복귀 시 작성 중 텍스트 유지(한영 혼합·줄바꿈), 포커스 복귀, 이후 실제 제출(로컬 DB에 `pending` 저장) → 링크 사라짐.
- 마지막 화면·재방문 화면 → 피드 → 복귀, 방금 제출한(pending) 소원은 피드에 없음.
- 승인 0건 빈 상태, HTML 문자열이 실행되지 않고 텍스트로 표시, 줄바꿈 유지, 140자 한영 혼합 가로 스크롤 없음, 20+5 더 보기.
- 오프라인 → 오류·Try again → 복구, 2페이지 실패 시 1페이지 유지·재시도, 서버 404 → 오류 상태, 숨김 처리된 소원은 다시 열 때 사라짐.
- 키보드: Tab으로 링크 도달·Enter로 열기·Back에 포커스·더 보기 후에도 포커스가 피드 안·Escape로 닫고 포커스 복귀.
- 플래그 off: 마지막 화면 버튼 → 기존 이메일 모달, `/api/social` 요청 0건, 입력 화면 링크 없음.
- 검수 페이지(모바일·데스크톱): 로그인 전 목록 없음, 틀린 비밀번호 안내, 비밀번호·세션이 저장소/JS 쿠키/URL에 없음, 대기 26건 중 20건, 전화번호·링크 힌트, 승인 더블탭 → 요청 1건, 개수 갱신, 반려·숨김, 다른 곳에서 먼저 처리된 카드 안내 및 덮어쓰기 없음, 제3자·분석 요청 0건, 페이지 오류 0건.
- 소원 텍스트가 PostHog 호출 큐에 들어가지 않음, 서버 로그에 오류 코드 외 출력 없음.

## 5. 스크린샷 (`m-` 390×844, `d-` 1280×800)

| | |
|---|---|
| 입력 화면(작성 중) | [m-01](m-01-wish-screen-draft.jpg) · [d-01](d-01-wish-screen-draft.jpg) |
| 피드 빈 상태 | [m-02](m-02-feed-empty.jpg) · [d-02](d-02-feed-empty.jpg) |
| 피드 첫 화면 / 더 보기 / 끝 | [m-03](m-03-feed-top.jpg) [m-04](m-04-feed-more-button.jpg) [m-05](m-05-feed-end.jpg) · [d-03](d-03-feed-top.jpg) [d-05](d-05-feed-end.jpg) |
| 입력 화면 복귀(텍스트 유지) | [m-06](m-06-back-to-wish.jpg) · [d-06](d-06-back-to-wish.jpg) |
| 마지막 화면 / 재방문 | [m-07](m-07-ending-share.jpg) [m-08](m-08-revisit.jpg) · [d-07](d-07-ending-share.jpg) [d-08](d-08-revisit.jpg) |
| 네트워크 오류 | [m-09](m-09-feed-offline.jpg) |
| 플래그 off 이메일 모달 | [m-10](m-10-flag-off-email.jpg) |
| 검수: 로그인 / 대기 목록 / 승인 후 / 승인 탭 | [m-11](m-11-admin-login.jpg) [m-12](m-12-admin-pending.jpg) [m-13](m-13-admin-approved-toast.jpg) [m-14](m-14-admin-approved-tab.jpg) · [d-11](d-11-admin-login.jpg) [d-12](d-12-admin-pending.jpg) |

화면의 소원은 모두 테스트 데이터입니다.

## 6. MIN-144 (출처·고지)

피드는 불투명 전체 화면이라 모델이 보이지 않으며, 하단에 "Wishes are shown anonymously. / Unofficial fan-made project. Not affiliated with Obsession or its studio."를 둡니다. 닫으면 기존 하단 표기(`.credit`)가 그대로 돌아오고 배치는 변경하지 않았습니다(m-07, m-08). 첫 화면의 CC BY Credits 링크는 수정하지 않았습니다. 최종 판단은 프리뷰에서 확인이 필요합니다.

## 7. 미검증 항목과 운영 전 필요 작업

- **실제 Vercel·Neon에서의 실행은 미검증**(컨테이너에서 접속 불가). 프리뷰 배포에서 확인 필요: Web 핸들러의 `request.url` Origin이 배포 도메인과 일치하는지(로그인 403이 나오면 이 부분), `__Host-` 쿠키 설정, `vercel.json` 헤더 적용, Neon HTTP 드라이버의 타임스탬프·int8 반환 형식.
- 실제 휴대폰(iOS Safari·인앱 브라우저)에서의 피드 스크롤·키보드·Back 동작, 검수 페이지 사용감.
- 로그인 시도 제한은 인스턴스별(위 3절).
- MIN-176 결정 전까지 기존 수집분 승인 금지 — 페이지에 안내만 있고 서버에서 막지는 않습니다.
- `social_feed_opened`가 플래그 on에서 `social_interest_clicked`를 대체하므로 버튼 클릭률 계산식을 on 이후 바꿔야 합니다.
- 운영 전: Preview 환경 변수(`SOCIAL_ENABLED`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`) 등록 → 프리뷰 전용 브랜치에서 `js/config.js` 플래그 on → 승인→노출→숨김→제거, 미제출자 복귀, 모바일·데스크톱 확인 → 머지·플래그 전환(MIN-164).
