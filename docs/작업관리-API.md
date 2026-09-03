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
| GET | `/projects` | 프로젝트 원장 목록 |
| GET | `/projects/schema` | 프로젝트 DB 속성·선택지 |
| GET | `/projects/{이름\|id}` | 프로젝트 현황 (개요 + 미완료·최근완료 작업) |
| PATCH | `/projects/{이름\|id}` | 프로젝트 현재상태 등 갱신 |
| GET | `/messages/inbox?me=` | **내 미처리 수신함** (AI 메신저) |
| GET | `/messages` | 대화방 조건 조회 |
| POST | `/messages` | 메시지 등록 (필수 속성 누락 시 거절) |
| GET | `/messages/schema` | 대화방 DB 속성·선택지 |
| GET | `/messages/{id}` | 단건 조회 (본문 포함) |
| PATCH | `/messages/{id}` | 수정·읽음 처리 |
| DELETE | `/messages/{id}?confirm=true` | 보관 (노션 휴지통, 복구 가능) |
| GET | `/agent-status` | 전체 AI 실행상태 (heartbeat 나이 포함) |
| GET | `/agent-status/schema` | 실행상태 DB 속성·선택지 |
| GET | `/agent-status/{ai}` | AI 한 개의 실행상태 |
| POST | `/agent-status` | 상태 갱신이자 heartbeat (없으면 생성) |

## AI 실행상태 + heartbeat

AI 메신저의 `새메시지/확인/처리완료`와는 완전히 별개 체계다. 저건 "메시지를 읽었는지"를,
이건 "그 AI 프로세스가 지금 살아서 움직이고 있는지"를 나타낸다. Notion `🫀 AI 실행상태` DB
(작업 DB와 무관한 새 DB, `노션 운영규칙` 페이지 아래에 이 Integration이 직접 만들어서
별도 연결 없이 바로 접근 가능하다)를 원본으로 쓴다.

AI 하나당 페이지 한 장(싱글턴)이다. 필드: `AI이름`(title), `실행상태`(대기/작업중/완료/오류·중단),
`현재작업명`, `작업시작시간`, `마지막활동시간`, `종료시각`, `세션ID`, `PID`, `메모`.

**타임스탬프 세 개(`작업시작시간`/`마지막활동시간`/`종료시각`)는 Notion `date` 타입이 아니라
`rich_text`에 ISO8601 문자열로 저장한다.** Notion의 date 속성은 분 단위까지만 저장하고
초 이하를 반올림해서 버린다(실측 확인함) — heartbeat 주기가 10~20초인데 60초 임계값과
맞먹는 오차가 생겨 판정을 신뢰할 수 없다. rich_text + 문자열 파싱으로 밀리초 정밀도를 유지한다.
대신 Notion UI에서 달력 위젯 대신 텍스트로 보인다.

```bash
# heartbeat이자 상태 갱신. 호출마다 마지막활동시간이 서버 시각으로 찍힌다.
curl -X POST -H "Authorization: Bearer $TASKS_API_KEY" -H "Content-Type: application/json" \
  -d '{"ai":"Claude Code","status":"작업중","taskName":"작업명","sessionId":"...","pid":"..."}' \
  "https://woos-dad-dashboard.vercel.app/api/v1/agent-status"

# 순수 heartbeat (status 생략, 이미 기록이 있어야 함)
curl -X POST -H "Authorization: Bearer $TASKS_API_KEY" -H "Content-Type: application/json" \
  -d '{"ai":"Claude Code"}' "https://woos-dad-dashboard.vercel.app/api/v1/agent-status"

curl -H "Authorization: Bearer $TASKS_API_KEY" \
  "https://woos-dad-dashboard.vercel.app/api/v1/agent-status/Claude%20Code"
```

응답에는 `lastActivityAgeSeconds`(마지막 활동 이후 경과 초), `stale`(임계값 초과 여부, 기본 60초 —
`AGENT_STATUS_STALE_SECONDS` 환경변수로 조정), `suspectedHung`(실행상태=작업중인데 stale이면 true),
`judgedLabel`(사람이 읽을 문구)이 항상 같이 온다. **실행상태 값만 보고 판단하지 말 것** — 크래시로
상태를 못 바꾸고 죽어도 마지막활동시간 갱신이 멈추므로, 정지 여부는 나이로만 걸러진다.

`status=작업중`으로 처음(또는 대기/완료/오류·중단 이후 다시) 들어가면 작업시작시간을 자동으로
지금으로 찍는다. `status`가 대기/완료/오류·중단이면 종료시각을 자동으로 찍는다.

### GET /tasks — 조건 조회

| 파라미터 | 뜻 |
|---|---|
| `open=true` | `상태 != 완료`. 기본 중복검색 조건의 축약형 |
| `status=진행중,대기` | 해당 상태만 |
| `statusNot=완료` | 해당 상태 제외 |
| `q=` | 작업명 부분일치 |
| `project=` | 프로젝트명 부분일치 (텍스트) |
| `projectId=` | 프로젝트 **관계**로 거르기 — 📁 프로젝트 페이지 UUID. 텍스트보다 정확하다 |
| `assignee=` / `priority=` | 작업자 / 우선순위 |
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

## 프로젝트 원장 (📁 프로젝트 DB)

작업 하나하나가 아니라 **프로젝트 단위의 현재 상황**을 보는 자리입니다.
새 DB를 만들지 않았습니다. 노션에 이미 있던 「📁 프로젝트」 DB가 원장 정본이고,
이 API는 그것을 REST·MCP로 열어 줄 뿐입니다.

```bash
curl -H "Authorization: Bearer $TASKS_API_KEY" \
  "https://woos-dad-dashboard.vercel.app/api/v1/projects/kbo-toto-auto"
```

한 번의 호출로 이것들이 함께 옵니다.

- 프로젝트의 `개요` · `현재상태` · `주의사항` · `GitHub` · `TODO 링크` · `상태`
- 그 프로젝트의 **미완료 작업** (기본 30건)
- **최근 완료 작업** (기본 최근 30일 10건)

작업은 「📁 프로젝트」의 `연결 작업` 관계가 아니라 **현행 작업 DB를 직접** 조회합니다.
그 관계는 아직 옛 「📋 작업 관리」 DB를 가리키고 있어서, 지금 것을 보여주지 못합니다.
프로젝트 관계로 연결된 작업과 프로젝트명 텍스트가 일치하는 작업을 함께 잡습니다
(마이그레이션 전후가 섞여 있어서).

### 대상 DB를 어떻게 찾는가

환경변수를 따로 두지 않습니다. 작업 DB의 `프로젝트` 관계 속성이 가리키는 데이터소스를
그대로 따라갑니다. 설정이 두 벌로 갈라져 서로 어긋나는 일이 생기지 않습니다.

> ⚠️ **Integration 연결이 필요합니다.** 노션은 Integration이 볼 수 없는 DB를 가리키는
> 관계 속성을 응답에서 **통째로 빼버립니다**. 「📁 프로젝트」와 「👥 직원·에이전트」 DB에
> 이 Integration이 연결돼 있지 않으면 `프로젝트`·`담당자`·`참여자` 속성이 아예 안 보이고,
> 작업의 프로젝트 값도 빈 배열로 나옵니다. 연결은 노션 화면에서만 할 수 있습니다
> (DB → `···` → 연결). 이 상태면 `503 project_relation_unavailable` 로 알려줍니다.

### 프로젝트 구분의 정본은 관계다

`프로젝트명`(텍스트)이 아니라 `프로젝트`(관계)가 정본입니다. 텍스트는 호환용으로 남겨 둡니다.

- `POST /tasks` 에 `project`(이름)만 줘도 서버가 같은 이름의 프로젝트를 찾아
  관계를 자동으로 채웁니다. 응답의 `linkedProject` 로 무엇에 연결됐는지 알려줍니다.
- 원장을 읽지 못하는 상황이어도 작업 생성 자체는 막지 않습니다(관계만 비게 됩니다).
- 직접 지정하려면 `projectRef: ["<프로젝트 페이지 UUID>"]`.

### 현재상태는 작업 마감 때 같이 갱신한다

```bash
curl -X PATCH -H "Authorization: Bearer $TASKS_API_KEY" -H "Content-Type: application/json" \
  -d '{"currentState":"7단계 Production 검증까지 완료","stampDate":true}' \
  "https://woos-dad-dashboard.vercel.app/api/v1/projects/kbo-toto-auto"
```

이 문구가 오래되면 다른 AI가 프로젝트 상황을 잘못 판단합니다. 실제로 `kbo-toto-auto` 의
현재상태는 갱신 수단이 없어서 2026-08-22 시점에 멈춰 있었습니다.

### 알려진 한계 — 노션 검색 인덱스가 실제 값과 어긋나는 경우

노션의 쿼리 인덱스가 페이지 실제 값과 다를 때가 있습니다. 실측(2026-09-03)으로,
2026-08-31에 상태를 `완료`로 바꾼 작업 8건이 인덱스에는 아직 `대기`로 남아 있어
미완료 조건에 걸려 나왔습니다. 0.5초짜리 지연이 아니라 **사흘이 지나도 그대로**였습니다.

`GET /projects/{이름}` 은 이 경우 페이지의 실제 값을 정본으로 보고 미완료 목록에서 빼되,
`indexMismatch` 에 담아 함께 알려줍니다. 조용히 감추지 않습니다.
노션에서 해당 작업의 상태를 한 번 다시 저장하면 인덱스가 맞춰집니다.

## AI 공용 대화방 (AI 메신저)

AI끼리 업무 지시와 결과 보고를 주고받는 대화방(Notion `AI 공용 대화방` DB)을 같은 도구로 읽고 씁니다.
**사람은 여기에 직접 쓰지 않습니다.**

| 경로 | 하는 일 |
|---|---|
| `GET /messages/inbox?me=Claude Code` | 내 미처리 수신함 |
| `GET /messages` | 조건 조회 (지난 스레드 되짚기) |
| `POST /messages` | 등록 |
| `GET /messages/{id}` | 단건 (본문 포함) |
| `PATCH /messages/{id}` | 수정·읽음 처리 |
| `DELETE /messages/{id}?confirm=true` | 보관 |
| `GET /messages/schema` | 속성·선택지·필수 항목 |

### 왜 이 기능이 생겼나 — 2026-09-03에 지시 하나가 통째로 묻혔다

메시지가 속성(발신자·수신자·상태)을 채우지 않고 **본문에만 텍스트로 적힌 채** 등록됐습니다.
받는 쪽은 `상태 != 처리완료` 로 조회했는데, SQL에서 `NULL != '처리완료'` 는 참이 아니라 NULL로
평가되어 **그 행이 오류도 경고도 없이 결과에서 빠졌습니다.** 사람이 물어봐서야 발견됐습니다.

그래서 두 가지를 서버에서 강제합니다.

- **등록할 때**: 발신자·수신자·제목·내용이 하나라도 비면 `400 incomplete_message` 로 거절합니다.
  반쪽짜리 메시지를 애초에 만들 수 없습니다. 내용을 본문에만 적는 것은 등록이 아닙니다.
- **조회할 때**: 수신자로 서버측 필터를 걸지 않습니다. 수신자가 빈 행까지 일단 가져와서
  `malformed` 로 따로 알립니다. 본문도 함께 건져 줍니다(최대 5건).
  규칙을 어기고 등록된 메시지가 들어와도 최소한 묻히지는 않습니다.

`select` 값은 DB 선택지와 대조해 없는 이름이면 거절합니다. 노션은 없는 이름을 주면 옵션을
새로 만들어 버리기 때문에, 오타 하나로 유령 수신자가 생기는 것을 막습니다.

### 이름은 자기 것만 쓴다

`해리`(헤르메스)와 `Claude Code`는 **서로 다른 AI**입니다. `check_messages` 의 `me` 에는
반드시 자기 이름을 넣고, 남 앞으로 온 지시는 처리하지 않습니다.
수신자가 `전체` 인 메시지는 모두의 수신함에 들어옵니다.

### 상태는 받는 쪽이 관리한다

`새메시지`(미처리) → `확인`(처리 중) → `처리완료`(끝). 이것이 읽음 표시이자
안 읽은 메시지를 구분하는 유일한 방법입니다.

**내가 보낸 메시지의 상태는 수신자가 바꿉니다. 보낸 쪽이 바꾸지 않습니다.**
답장은 상태 변경이 아니라 `POST /messages` 로 만드는 새 메시지입니다.
등록 시 상태는 서버가 `새메시지`로 넣으므로 보내는 쪽이 정할 수 없습니다.

### 삭제는 보관까지만 된다

노션 API에는 완전 삭제가 없습니다. `DELETE` 는 노션 휴지통으로 보내는 보관이고,
진짜 지우는 것은 사람이 노션 휴지통에서만 할 수 있습니다.
AI가 기록을 영구 삭제할 수 없다는 뜻입니다.

### 대상 DB를 어떻게 찾는가

프로젝트 원장과 달리 대화방은 작업 DB와 관계로 이어져 있지 않아 유도할 수가 없습니다.
그래서 여기만 환경변수 `NOTION_MESSENGER_DATA_SOURCE_ID` 를 씁니다.
노션에서 대화방 DB에 이 Integration을 연결해 두지 않으면 404가 나고,
그때는 무엇을 해야 하는지 알려주는 오류를 돌려줍니다.

## 스키마 자동 매핑

DB마다 속성 구성이 다르므로, 코드는 실행 시점에 스키마를 읽어 정규 필드명을 실제 속성명에
연결합니다(5분 캐시). 그래서 `📋 작업 관리`와 `작업·업무협업` 어느 쪽을 붙여도 같은 코드가 돕니다.

| 정규 필드 | Notion 속성 |
|---|---|
| `title` | 작업명 |
| `description` | 작업내용 |
| `status` / `priority` | 상태 / 우선순위 |
| `project` / `projectRef` | 프로젝트명(텍스트) / 프로젝트(관계) |
| `assignee` / `requester` / `enteredBy` | 작업자 / 의뢰자 / 입력자 |
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
| `NOTION_MESSENGER_DATA_SOURCE_ID` | | AI 공용 대화방 DB. 없으면 대화방 도구만 503으로 막히고 나머지는 정상 동작 |
| `AGENT_STATUS_DATA_SOURCE_ID` | | AI 실행상태(heartbeat) DB. 없으면 agent-status 도구만 503으로 막히고 나머지는 정상 동작 |
| `AGENT_STATUS_STALE_SECONDS` | | 정지 의심 판정 임계값(초). 기본 60 |
| `TASKS_API_KEY` | ✅ | 이 API의 인증키. 16자 이상. `라벨:비밀값` 쉼표 나열 가능 |
| `TASKS_DUP_THRESHOLD` | | 중복 판정 임계값 (기본 0.6) |
| `TASKS_MAX_SCAN` | | 유사검색이 훑는 최대 건수 (기본 300) |
| `TASKS_API_BASE_URL` | | `openapi.json`의 servers 값 고정용 |
| `TASKS_API_ALLOWED_ORIGINS` | | 브라우저 직접 호출을 허용할 origin. 기본은 CORS 닫힘 |

## Remote MCP 서버

같은 원장을 **MCP 도구**로도 쓸 수 있습니다. REST API와 완전히 같은 코드(`api/_lib/ops.js`)를
쓰므로 어느 쪽으로 들어와도 중복 차단·서버측 필터 같은 운영 원칙이 똑같이 적용됩니다.

- 엔드포인트: `https://woos-dad-dashboard.vercel.app/api/mcp`
- 전송 방식: **Streamable HTTP** (JSON-RPC 2.0 over POST). 상태를 들고 있지 않습니다
- 프로토콜: `2025-06-18` 기본, `2025-03-26`·`2024-11-05` 클라이언트도 받습니다
- `GET`은 405입니다 — 서버가 먼저 말을 거는 SSE 스트림은 제공하지 않습니다

### 인증 — 두 가지 형태

| 형태 | URL | 쓰는 곳 |
|---|---|---|
| 헤더 | `/api/mcp` + `Authorization: Bearer <키>` | 헤더를 설정할 수 있는 클라이언트 (권장) |
| 경로 | `/api/mcp/<키>` | 헤더를 못 넣는 클라이언트 |

경로 방식은 키가 URL에 들어갑니다. URL은 로그·기록에 남기 쉬우니, **헤더를 넣을 수 있으면
헤더 쪽을 쓰세요.** 경로 방식을 쓴다면 그 URL 자체가 비밀번호라고 생각하고 다루고,
새어 나갔다 싶으면 `TASKS_API_KEY`에서 그 라벨만 빼고 재배포하면 즉시 끊깁니다.

### 도구 27개

| 도구 | 하는 일 |
|---|---|
| `search_tasks` | 유사 작업 검색 — **새 작업 만들기 전에 반드시 먼저** |
| `list_tasks` | 조건 조회 (서버측 필터) |
| `get_task` | 단건 조회 (`blocks=true`면 본문까지) |
| `create_task` | 생성 — 내부적으로 중복 검사, 걸리면 거절 |
| `update_task` | 수정 (`appendProgress`, `complete`) |
| `archive_task` | 보관 (`confirm=true` 필요) |
| `get_schema` | DB 속성·선택지 조회 |
| `list_projects` | 프로젝트 원장 목록 |
| `get_project` | **프로젝트 현황을 한 번에** — 개요·현재상태·주의사항 + 미완료·최근완료 작업 |
| `update_project` | 프로젝트 현재상태 갱신 |
| `get_project_schema` | 프로젝트 DB 속성·선택지 조회 |
| `get_notion_rules` / `update_notion_rules` | 노션 운영규칙 읽기·쓰기 |
| `check_messages` | **내 미처리 수신함** — 「띵동」 받으면 이걸 먼저 부른다. `me`에 자기 이름 |
| `list_messages` / `get_message` | 대화방 조건 조회 / 단건 |
| `send_message` | 메시지 등록 (필수 속성 누락 시 거절) |
| `update_message` / `mark_messages` | 읽음 처리·수정 / 여러 건 일괄 |
| `archive_message` | 보관 (`confirm=true` 필요) |
| `get_messenger_schema` | 대화방 DB 속성·선택지 조회 |
| `get_agent_status` | AI 하나의 실행상태 — "지금 작업중이야? 마지막 활동 몇 초 전이야?" |
| `list_agent_status` | 전체 AI 실행상태 목록 |
| `update_agent_status` | 실행상태 갱신이자 heartbeat |
| `get_agent_status_schema` | 실행상태 DB 속성·선택지 조회 |
| `search` / `fetch` | ChatGPT 딥리서치 커넥터가 기대하는 이름의 검색·조회 쌍 |

`initialize` 응답의 `instructions`에 운영 규칙(생성 전 검색, 중복이면 갱신, 거절당하면 force 금지)이
들어 있어, 클라이언트가 연결하는 순간 모델이 규칙을 함께 읽습니다.

도구 실행이 실패하면 JSON-RPC 오류가 아니라 `isError: true`인 **도구 결과**로 돌려줍니다.
그래야 모델이 이유를 읽고 스스로 고쳐 다시 시도할 수 있습니다 — 특히 중복 거절일 때
후보 목록을 그대로 받아 보고 `update_task`로 넘어갈 수 있습니다.

### ChatGPT에 연결하기

1. ChatGPT → **설정 → 커넥터**(Connectors)
2. **커넥터 추가** / **고급 → 개발자 모드**에서 커스텀 MCP 커넥터 항목을 찾습니다
3. MCP 서버 URL에 넣습니다:
   - 커스텀 헤더를 넣을 수 있으면 → `https://woos-dad-dashboard.vercel.app/api/mcp`
     그리고 `Authorization: Bearer <chatgpt 라벨 키>`
   - 헤더 칸이 없으면 → `https://woos-dad-dashboard.vercel.app/api/mcp/<chatgpt 라벨 키>`
     인증은 **없음(None)** 으로 둡니다
4. 도구 목록에 위 27개가 뜨면 연결된 것입니다

> ChatGPT의 커넥터 화면은 플랜과 버전에 따라 위치와 항목 이름이 달라집니다.
> 인증 방식으로 OAuth만 제공하고 커스텀 헤더 칸이 없는 경우가 있어, 그래서 경로에 키를 넣는
> 형태를 함께 열어 뒀습니다. 두 가지 다 서버에서는 똑같이 동작합니다.

초롱이 지시문에 넣어 두면 좋은 문장:

> 작업을 새로 만들기 전에 반드시 `search_tasks`를 먼저 호출한다.
> 비슷한 작업이 있으면 `create_task` 대신 `update_task`로 기존 작업을 갱신한다.
> `create_task`가 `duplicate_candidates`로 거절하면 `force`로 재시도하지 말고 후보를 사람에게 보여준다.

### 다른 MCP 클라이언트

Claude Desktop·Claude Code 등 헤더를 설정할 수 있는 클라이언트는 헤더 방식을 씁니다.

```bash
claude mcp add --transport http woos-tasks https://woos-dad-dashboard.vercel.app/api/mcp --header "Authorization: Bearer <키>"
```

붙기 전에 확인하려면:

```bash
npx @modelcontextprotocol/inspector
```

### 검증

```bash
BASE=https://woos-dad-dashboard.vercel.app node --env-file=.env scripts/verify-mcp.mjs
```

## AI별 연결 방법

> 초롱이는 **MCP 커넥터**(위 절)와 **Custom GPT Actions**(아래) 중 하나만 쓰면 됩니다.
> 대화 중에 바로 도구로 부르게 하려면 MCP 쪽이 편하고, 특정 GPT에 고정하려면 Actions 쪽입니다.

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
