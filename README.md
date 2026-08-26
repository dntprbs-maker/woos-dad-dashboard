# WOO'S 아빠 대시보드

현재 UI 시안에 Notion `작업·업무협업` DB 읽기 API를 연결한 Vercel 프로젝트입니다.

## 필요한 Vercel 환경변수
- `NOTION_TOKEN`: Notion Integration Secret
- `NOTION_DATABASE_ID`: 기본값이 코드에 포함되어 있어 선택사항

Notion Integration에는 해당 DB에 대한 읽기 권한을 부여해야 합니다.

## 동작
- `/api/tasks`가 Notion 작업 DB를 최대 100개씩 페이지네이션하여 전부 읽음
- 프로젝트명으로 묶음
- 상태=`완료`면 한 일, 그 외는 할 일
- 완료 정렬은 `완료일시 → 작업일 → 날짜 없음` 순
- API 연결 전에는 기존 시안 데이터가 보이고, 연결 성공 시 실데이터로 교체
