# WOO'S 아빠 대시보드

현재 UI 시안에 Notion `작업·업무협업` DB 읽기 API를 연결한 Vercel 프로젝트입니다.

여기에 더해, 여러 AI가 같은 작업 원장을 공유하기 위한 **공용 작업관리 API**가
같은 프로젝트 안에 함께 배포됩니다 → [docs/작업관리-API.md](docs/작업관리-API.md)

- `/api/v1` — REST (HTTP+JSON)
- `/api/mcp` — Remote MCP 서버 (Streamable HTTP). 같은 로직을 도구로 노출합니다

## 필요한 Vercel 환경변수
- `NOTION_TOKEN`: Notion Integration Secret
- `NOTION_DATABASE_ID`: 기본값이 코드에 포함되어 있어 선택사항
- `DASHBOARD_PASSWORD`: 대시보드 접속 비밀번호 (**필수**)
- `NOTION_DATA_SOURCE_ID`, `TASKS_API_KEY`: 공용 작업관리 API `/api/v1`용 (**필수**)

> ⚠️ `DASHBOARD_PASSWORD`가 설정돼 있지 않으면 `/api/tasks`는 데이터를 내주지 않고 503을 반환합니다.
> 설정 누락 시 실데이터가 새어나가지 않도록 일부러 막아두는 동작입니다.

Notion Integration에는 해당 DB에 대한 읽기 권한을 부여해야 합니다.

## 동작
- `/api/tasks`가 Notion 작업 DB를 최대 100개씩 페이지네이션하여 전부 읽음
- 프로젝트명으로 묶음
- 상태=`완료`면 한 일, 그 외는 할 일
- 완료 정렬은 `완료일시 → 작업일 → 날짜 없음` 순
- API 연결 전에는 기존 시안 데이터가 보이고, 연결 성공 시 실데이터로 교체

## 접속 보호
노션 실데이터가 나가는 `/api/tasks`는 비밀번호 없이는 열리지 않습니다.

- 처음 접속하면 비밀번호 입력창이 뜹니다
- `POST /api/login`이 비밀번호를 확인하고 인증 쿠키(`dash`)를 발급합니다
  - 쿠키에는 비밀번호가 아니라 SHA-256 해시가 담기고, `HttpOnly` / `Secure` / `SameSite=Strict`로 설정됩니다
  - 유효기간 30일 — 한 번 입력하면 브라우저가 기억합니다
- `/api/tasks` 응답은 `Cache-Control: private, no-store`라 Vercel 엣지 캐시에 남지 않습니다

⚠️ 보호되는 것은 **노션 실데이터**입니다. `index.html` 자체와 그 안의 시안 데이터는 공개 상태입니다.

## 배포
- 운영 URL: https://woos-dad-dashboard.vercel.app
- GitHub `main` 브랜치에 push하면 Vercel이 자동 재배포합니다 (Git 연동, 2026-08-27 설정).
