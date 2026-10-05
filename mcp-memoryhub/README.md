# WOO'S 메모리허브 MCP

공식 Notion 도구 없이도 Notion 워크스페이스(이 통합에 공유된 전 영역)를 조회·검색·생성·수정·이동·Relation·스키마·휴지통 처리까지 할 수 있는 통합 MCP 서버.
「WOO'S 공용데이터 저장소 MCP」(`woos-common-data-store`, SQLite)와는 **별개**다.

- 런타임: Node.js 24 + TypeScript + `@modelcontextprotocol/sdk` (stdio)
- Notion API: 공식 REST, `Notion-Version: 2025-09-03` (데이터소스 모델)
- 이름은 「메모리허브」지만 **접근 범위는 메모리허브 페이지로 제한하지 않는다** — 통합에 공유된 워크스페이스 전체가 대상.

## 설치·실행·연결

```bash
cd C:\Users\user\projects\woos-memoryhub-mcp
npm install
npm run build
```

Claude Code(전 프로젝트 공용) 등록 — 이미 등록됨(2026-10-05):

```bash
claude mcp add -s user woos-memoryhub -- node C:\Users\user\projects\woos-memoryhub-mcp\dist\index.js
```

다른 MCP 클라이언트(Codex 등)는 같은 명령(`node <경로>\dist\index.js`)을 stdio 서버로 등록하면 된다.

### 토큰 (Secret)

코드·Git·설정 파일에 토큰을 넣지 않는다. 실행 시 다음 순서로 읽는다.

1. 환경변수 `WOOS_NOTION_TOKEN` 또는 `NOTION_TOKEN`
2. `WOOS_NOTION_ENV_FILE`이 가리키는 .env 파일의 `NOTION_TOKEN`
3. 기본값: `C:\Users\user\projects\woos-dad-dashboard\.env`의 `NOTION_TOKEN` (Notion 통합 「아빠 대시보드」)

오류 메시지에서 토큰 문자열은 `***`로 가린다.

### 접근 범위 (중요)

2026-10-05 기준 통합 「아빠 대시보드」에 최상위 13곳 공유(객체 908개, WOO'S 메모리허브·AI 회사 본부·날짜별 작업일지 포함). MCP가 볼 수 있는 범위 = 해당 Notion 통합에 **연결(공유)된 페이지와 그 하위 전부**. 통합에 공유되지 않은 최상위 페이지는 보이지 않는다.
범위를 넓히려면 Notion에서: 설정 → 연결 → 「아빠 대시보드」 → 액세스 권한에서 최상위 페이지를 추가하거나, 각 최상위 페이지 우측 상단 `•••` → 연결 → 「아빠 대시보드」 추가.

## 도구 (30개)

| 구분 | 도구 | 설명 |
|---|---|---|
| 조회 | `get` | 페이지/DB/데이터소스/블록 자동 판별, 제목·부모·휴지통 여부·속성(단순값)·relation |
| | `get_content` | 본문 → Markdown |
| | `list_children` | 하위 페이지·DB, 또는 DB 레코드 목록 |
| | `get_schema` | DB 스키마(속성·선택지·relation 대상) |
| | `query` | DB 조건 조회 (`where` 단순조건 / `filter` 원형 / `sorts`) |
| 검색 | `search` | 제목 검색, `scope_id` 범위 한정, `include_content`로 범위 내 본문 검색 (= search_everything) |
| 생성 | `create_page` | 일반 페이지 또는 DB 레코드(속성·본문 포함) |
| | `create_database` | DB 생성(스키마 지정) |
| 수정 | `update_page` | 제목·속성(select/multi/date/text/number/checkbox/url/relation/people)·아이콘 |
| | `write_content` | 본문 append / replace(하위 페이지·DB 보존) / replace_text |
| | `set_relation` | relation add/remove/set |
| | `update_schema` | 속성 추가·이름변경·삭제·선택지 변경, 제목 |
| 구조 | `move` | 페이지 → 페이지/DB, DB(데이터소스) → 페이지 |
| 휴지통 | `trash_prepare` → `trash_execute` | 2단계 승인 (아래 안전장치) |
| | `restore` | 복원 |
| 검증 | `verify_change` | 제목·휴지통·부모·속성·본문 기대값 대조 |
| 원형 | `api_request` | GET/POST/PATCH 원형 호출 (휴지통·운영규칙 수정은 차단) |
| 작업 원장 | `task_search` `task_get` `task_create` `task_start` `task_update` `task_finish` | 운영규칙 「작업 원장 사용 절차 (2026-10-05)」 내장 |
| 운영규칙 | `rules_get` `rules_update` | 수정은 아빠 지시 문구 필수 |
| 작업일지 | `worklog_get` `worklog_write` | 「날짜별 작업일지」 하위 `YYYY년 M월 D일 작업일지` |
| 직원 | `employee_find` `employee_update` | 👥 직원·에이전트 DB |

모든 쓰기 도구는 **실행 → 다시 조회 → 반영 확인** 후 `verified`를 돌려준다. `verified=false`는 실패로 취급한다.

### 작업 원장 절차 (운영규칙 반영)

- `task_create`: 미완료 + 최근 7일 완료를 먼저 검색해 유사 작업이 있으면 **생성하지 않고 후보를 반환**(강제 생성 옵션 없음). 정말 다르면 `distinct_from`에 후보 ID와 이유를 명시. 작업명 `[프로젝트명]` 자동 부착, 프로젝트 relation 자동 연결.
- `task_start`: 기존 기록(결정·파일·커밋·최근 진행·개입) 반환 → `진행중` → 재조회 검증. 완료 작업은 `reopen_completed` 없이는 거부.
- `task_update`: 진행·결정·파일·커밋 기록, 아빠 개입(없음/의사결정/직접조작 + 요청내용), 우선순위는 상/중/하만 (최상·최하는 아빠 전용이라 AI가 지정·변경 불가).
- `task_finish` (종료 게이트): 완료는 `verification` 필수·미해결 있으면 거부·아빠 확인이 성공조건이면 확인 전 거부 / 진행중은 `next_steps` 필수 / 대기는 외부조건 `waiting_for` 필수("다음 지시 대기" 거부) / 보류는 의도적 중단 사유 필수(아빠 부재·장소 거부) → 원장 수정 → 재조회로 상태·완료일시·기록 일치 검증.

### 삭제 안전장치

- 완료 ≠ 삭제. 휴지통은 `trash_prepare`(대상 재조회·하위 항목 수 표시·승인토큰, 30분, 1회용, 최대 20건) → `trash_execute` 2단계로만.
- 기존 데이터: `approved_by`에 아빠 + 아빠의 실제 삭제 지시 문구 필요. `'테스트 객체 정리'` 근거는 **이 MCP가 test_object로 만든 객체에만** 허용.
- 승인 후 제목·수정시각이 바뀐 대상은 처리하지 않음. 처리 후 재조회로 `in_trash` 검증.
- 보호 객체(운영규칙 4종·작업 원장·프로젝트·직원·프로그램·AI 공용 대화방 DB, 날짜별 작업일지, AI 회사 본부, 초롱이 세팅)는 MCP로 휴지통 처리 불가. 보호 DB의 속성 삭제도 불가.
- `api_request`로 `in_trash`/`archived` 우회 불가, 블록 DELETE 메서드 없음. `write_content replace`는 하위 페이지·DB 블록을 절대 지우지 않음.
- 운영규칙 문서는 일반 쓰기 도구로 수정 불가(`rules_update` + 아빠 지시 문구).
- 모든 쓰기는 `%LOCALAPPDATA%\woos-memoryhub-mcp\audit.jsonl`에 기록(토큰 미포함).

## 실검증

```bash
npm test   # = node dist/selftest.js
```

실제 MCP 프로토콜(stdio)로 서버를 띄워, 「초롱이 세팅」 아래 새 테스트 페이지에서 생성→재조회→제목/본문/속성 수정→DB 생성·스키마 수정→레코드 생성/수정→Relation 생성/해제→페이지·DB 이동→조건/제목/본문 검색→작업 원장 절차(테스트 작업)→안전장치→페이지·레코드·DB·데이터소스 휴지통→테스트 객체 정리까지 40개 항목(날짜별 작업일지: 실제 일지 읽기 + 존재하지 않는 2099-01-01 시험 일지 생성·추가·정리 포함)을 검사한다. 2026-10-05 40/40 통과(연속 2회).

## 공식 Notion MCP 대비

| 기능 | 공식 Notion MCP | 메모리허브 MCP |
|---|---|---|
| 페이지 조회·본문 조회·검색 | ○ (AI 검색 포함) | ○ 제목 검색 + 범위 내 본문 검색 (워크스페이스 전체 본문 검색은 Notion API에 없음) |
| 페이지 생성·본문·속성 수정 | ○ | ○ |
| DB/데이터소스 조회·생성·스키마 수정 | ○ | ○ |
| Relation 추가·해제 | ○ (속성 덮어쓰기) | ○ add/remove/set + 재조회 |
| 페이지 이동 | ○ | ○ |
| DB 이동 | 미확인 | ○ |
| 페이지 휴지통 | ✕ (공식 도구에 삭제 없음) | ○ 2단계 승인 |
| DB/데이터소스 휴지통 | ✕ | ○ 2단계 승인 |
| 재조회 검증 | 수동 | 모든 쓰기에 내장 |
| 작업 원장 절차·종료 게이트 | ✕ | ○ |
| 댓글·사용자 | ○ | `api_request`(GET /users, GET·POST /comments) |
| 뷰(view) 생성·수정, 파일 업로드, 페이지 복제, 회의록, Notion AI 세션 | ○ | ✕ (필요 시 추가) |

## 환경변수

`WOOS_NOTION_TOKEN`, `WOOS_NOTION_ENV_FILE`, `WOOS_NOTION_VERSION`, `WOOS_MCP_STATE_DIR`, `WOOS_PROTECTED_IDS`(쉼표, 보호 추가), `WOOS_*_ID`(고정 ID 덮어쓰기, `src/core.ts` 참고), `WOOS_TEST_PARENT_ID`(실검증 위치).
