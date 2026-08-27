# 공용 작업관리 API

Notion 작업 DB를 **여러 AI가 함께 쓰는 하나의 원장**으로 다루기 위한 HTTP API입니다.
Notion 공식 REST API(`api.notion.com/v1`)만 사용하며, Notion MCP의 `query_data_sources`
사용량 한도와는 별개의 경로입니다.

- 기본 URL: `https://woos-dad-dashboard.vercel.app/api/v1`
- 인증: `Authorization: Bearer <TASKS_API_KEY>` (또는 `x-api-key: <키>`)
- 기계용 명세: `GET /api/v1/openapi.json`

## 운영 원칙 (API가 강제하는 것)

1. **새 작업 생성 전 중복 확인.** `POST /tasks`는 내부적으로 유사 작업 검색을 먼저 돌립니다.
   비슷한 작업이 있으면 만들지 않고 `409 duplicate_candidates`와 후보 목록을 돌려줍니다.
2. **전체를 매번 가져오지 않는다.** 모든 조회 조건은 Notion 서버에서 필터링됩니다.
   기본 중복검색 범위는 `상태 != 완료`이고, 필요할 때만 `완료 AND 완료일시 >= 최근 7일`까지 넓힙니다.
3. **완료 작업은 옮기지 않는다.** 별도 DB로 이관하지 않고 같은 DB에 남습니다.
4. **기존 작업이 있으면 수정한다.** `PATCH /tasks/{id}`로 진행내용·결정사항·상태를 갱신합니다.

## 엔드포인트

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/health` | 상태 확인 (인증 불필요) |
| GET | `/schema` | 대상 DB의 속성·선택지·정규필드 매핑 |
| GET | `/openapi.json` | OpenAPI 3.1 명세 |
| GET | `/tasks` | 조건 조회 (서버측 필터) |
| POST | `/tasks` | 신규 생성 (중복 검사 내장) |
| POST | `/tasks/search` | 제목·내용 기준 유사 작업 검색 |
| GET | `/tasks/{id}` | 단건 조회 (`?blocks=true`면 본문까지) |
| PATCH | `/tasks/{id}` | 기존 작업 수정 |
| DELETE | `/tasks/{id}?confirm=true` | 보관 (노션 휴지통, 복구 가능) |

### GET /tasks — 조건 조회

| 파라미터 | 뜻 |
|---|---|
| `open=true` | `상태 != 완료`. 기본 중복검색 조건의 축약형 |
| `status=진행중,대기` | 해당 상태만 |
| `statusNot=완료` | 해당 상태 제외 |
| `q=` | 작업명 부분일치 |
| `project=` | 프로젝트명 부분일치 |
| `assignee=` / `priority=` | 수행자 / 우선순위 |
| `completedSince=7d` | 완료일시 >= 7일 전 (`7d` 또는 `2026-08-20`) |
| `workDateSince=` / `workDateUntil=` | 작업일 범위 |
| `updatedSince=` | 최종수정 시각 기준 |
| `sort=-완료일시,작업명` | 정렬 (`-`는 내림차순, `last_edited_time`도 가능) |
| `limit=` (기본 25, 최대 100), `cursor=` | 페이지네이션 |

```bash
curl -H "Authorization: Bearer $TASKS_API_KEY" \
  "https://woos-dad-dashboard.vercel.app/api/v1/tasks?open=true&limit=50"
```

최근 완료까지 확인할 때:

```bash
curl -H "Authorization: Bearer $TASKS_API_KEY" \
  "https://woos-dad-dashboard.vercel.app/api/v1/tasks?status=%EC%99%84%EB%A3%8C&completedSince=7d&sort=-%EC%99%84%EB%A3%8C%EC%9D%BC%EC%8B%9C"
```

### POST /tasks/search — 유사 작업 검색

```json
{
  "title": "노션 작업관리 공용 API 만들기",
  "description": "선택",
  "project": "선택",
  "scope": "open",
  "threshold": 0.6,
  "limit": 10
}
```

`scope`: `open`(기본, 상태!=완료) · `recent-done`(완료 AND 완료일시>=N일) · `both` · `all`

유사도는 제목의 문자 bigram Dice 계수와 토큰 포함률을 섞어 계산합니다(한국어에 맞게 형태소
분석 없이 동작). 한쪽 제목이 다른 쪽을 통째로 포함하면 0.85 이상으로 봅니다.
응답의 `scanned`/`truncated`로 몇 건을 훑었고 잘렸는지 항상 알려줍니다 — 조용히 잘라내지 않습니다.

### POST /tasks — 신규 생성

```json
{
  "title": "작업명 (필수)",
  "description": "작업내용",
  "status": "대기",
  "priority": "중",
  "project": "프로젝트명",
  "assignee": "Claude Code",
  "requester": "아빠",
  "enteredBy": "초롱이",
  "workDate": "2026-08-27",
  "content": "페이지 본문에 넣을 텍스트"
}
```

중복이면 `409`:

```json
{
  "ok": false,
  "code": "duplicate_candidates",
  "candidates": [{ "id": "...", "title": "...", "score": 0.91, "matchedOn": "제목 0.91" }],
  "hint": "기존 작업을 고칠 때는 PATCH /api/v1/tasks/{id}. 그래도 새로 만들어야 하면 force:true."
}
```

옵션: `force: true`(중복검사 건너뜀), `duplicateCheck: false`, 또는
`duplicateCheck: { "scope": "both", "threshold": 0.7 }`.

> **알려진 한계 — 0.5초 이내 동시 생성**
> 노션의 쿼리 인덱스는 즉시 일관되지 않습니다. 실측하면 방금 만든 페이지가 조회에 잡히기까지
> **제목 부분일치 221ms, 전체 스캔 558ms** 걸립니다. 그 사이에 같은 제목으로 두 번째 요청이
> 들어오면 그 요청의 중복검사는 첫 번째를 아직 보지 못해 둘 다 만들어집니다.
> 1초만 지나도 정상적으로 409로 막힙니다.
> 사람이나 AI가 대화 중 작업을 만드는 속도로는 겹치지 않아 그대로 뒀습니다.
> 자동화(n8n 등)가 같은 트리거로 두 건을 동시에 쏘는 구조라면 호출하는 쪽에서 직렬화하세요.
> 이미 생긴 중복은 `GET /tasks?q=제목` 으로 찾아 정리할 수 있습니다.

### PATCH /tasks/{id} — 수정

```json
{
  "status": "진행중",
  "decision": "REST API 방식으로 확정",
  "appendProgress": "1차 검증 완료",
  "appendTo": "description"
}
```

- `appendProgress` + `appendTo`: 해당 텍스트 속성 끝에 `[YYYY-MM-DD HH:MM] 내용`으로 덧붙입니다.
- `appendTo`를 빼면 페이지 **본문 블록**으로 기록됩니다.
- `complete: true`: `상태=완료` + `완료일시=현재시각` 한 번에.

## 스키마 자동 매핑

DB마다 속성 구성이 다르므로, 코드는 실행 시점에 스키마를 읽어 정규 필드명을 실제 속성명에
연결합니다(5분 캐시). 그래서 `📋 작업 관리`와 `작업·업무협업` 어느 쪽을 붙여도 같은 코드가 돕니다.

| 정규 필드 | Notion 속성 |
|---|---|
| `title` | 작업명 |
| `description` | 작업내용 |
| `status` / `priority` | 상태 / 우선순위 |
| `project` / `projectRef` | 프로젝트명(텍스트) / 프로젝트(관계) |
| `assignee` / `requester` / `enteredBy` | 수행자 / 의뢰자 / 입력자 |
| `decision` / `note` / `commit` / `relatedFiles` | 결정사항 / 비고 / Git Commit / 관련파일 |
| `workDate` / `completedAt` / `duration` | 작업일 / 완료일시 / 작업시간 |
| `collabType` / `needsCheck` | 협업형태 / 확인필요 |
| `owners` / `participants` | 담당자 / 참여자 (관계) |

매핑에 없는 속성은 Notion 속성명을 그대로 키로 써도 됩니다. 읽을 때는 `raw`에 담겨 옵니다.
현재 DB에 어떤 속성이 있는지는 `GET /schema`로 확인하세요.

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `NOTION_TOKEN` | ✅ | Notion Integration Secret |
| `NOTION_DATA_SOURCE_ID` | ✅ | 대상 DB. database id / data source id 둘 다 인식 (`NOTION_DATABASE_ID`로도 인식) |
| `TASKS_API_KEY` | ✅ | 이 API의 인증키. 16자 이상. `라벨:비밀값` 쉼표 나열 가능 |
| `TASKS_DUP_THRESHOLD` | | 중복 판정 임계값 (기본 0.6) |
| `TASKS_MAX_SCAN` | | 유사검색이 훑는 최대 건수 (기본 300) |
| `TASKS_API_BASE_URL` | | `openapi.json`의 servers 값 고정용 |
| `TASKS_API_ALLOWED_ORIGINS` | | 브라우저 직접 호출을 허용할 origin. 기본은 CORS 닫힘 |

## AI별 연결 방법

### ChatGPT (초롱이) — Custom GPT Actions
1. GPT 편집 → **Actions** → **Import from URL**에
   `https://woos-dad-dashboard.vercel.app/api/v1/openapi.json` 입력
   (이 경로도 인증이 필요하므로, 안 읽히면 브라우저에서 받아 붙여넣기)
2. Authentication → **API Key** → Auth Type **Bearer** → `chatgpt:` 라벨 키 입력
3. GPT 지시문에 넣을 문장:
   > 작업을 새로 만들기 전에 반드시 `searchSimilarTasks`를 먼저 호출한다.
   > 비슷한 작업이 있으면 `createTask` 대신 `updateTask`로 기존 작업을 갱신한다.
   > `createTask`가 409를 돌려주면 절대 force로 재시도하지 말고 후보를 사람에게 보여준다.

### Claude Chat (별이) — 대화 중 호출
Claude Chat에서는 fetch 도구가 있을 때만 직접 호출됩니다. 없으면 아빠가 결과를 붙여넣는 방식이
현실적입니다. 프로젝트 지식(Project knowledge)에 이 문서와 `claude:` 라벨 키를 넣어 두세요.

### Claude Code
저장소 루트 `.env`에 키가 들어 있습니다.

```bash
curl -s -H "Authorization: Bearer $TASKS_API_KEY" \
  "https://woos-dad-dashboard.vercel.app/api/v1/tasks?open=true" | jq .
```

### n8n / 기타
HTTP Request 노드에 `Authorization: Bearer <키>` 헤더만 붙이면 됩니다.

## 로컬에서 돌려 보기

```bash
node --env-file=.env scripts/dev-server.mjs
```

```bash
node --env-file=.env scripts/verify.mjs
```

배포본 검증은 `BASE=https://woos-dad-dashboard.vercel.app` 를 앞에 붙입니다.

## 보안상 주의

- `NOTION_TOKEN`과 `TASKS_API_KEY`는 코드에 없습니다. 전부 환경변수이고 `.env*`는 커밋되지 않습니다.
- 로그에는 **키 라벨만** 남습니다(`chatgpt`/`claude`/`code`). 비밀값은 어떤 경로로도 출력되지 않습니다.
- 키 비교는 SHA-256 해시 후 `timingSafeEqual`로 합니다. 길이 차이로 정보가 새지 않습니다.
- 모든 응답은 `Cache-Control: private, no-store` — Vercel 엣지 공유 캐시에 남지 않습니다.
- CORS는 기본 차단입니다. 브라우저 JS에서 이 API를 부르면 키가 노출되므로 서버 쪽에서만 부르세요.
- Notion 토큰이 잘못됐을 때 `502`를 돌려줍니다(`401` 아님). 클라이언트 인증 실패와 구분하기 위해서입니다.
- `DELETE`는 영구 삭제가 아니라 노션 휴지통으로 보내는 보관입니다. `?confirm=true`가 없으면 거부합니다.
- 키가 새면 Vercel 환경변수에서 해당 라벨 항목만 빼고 재배포하면 그 AI만 끊깁니다.
