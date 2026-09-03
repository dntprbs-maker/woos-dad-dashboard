// 일회성 스크립트: "AI 실행상태" DB를 노션 운영규칙 페이지 아래에 만든다.
// 이 Integration이 직접 만드는 페이지/DB는 별도 "연결" 없이 즉시 접근 가능하다.
// 실행: node --env-file=.env scripts/create-agent-status-db.mjs
const TOKEN = process.env.NOTION_TOKEN;
const PARENT_PAGE_ID = process.env.NOTION_RULES_PAGE_ID;

if (!TOKEN || !PARENT_PAGE_ID) {
  console.error("NOTION_TOKEN / NOTION_RULES_PAGE_ID가 필요합니다 (.env 확인)");
  process.exit(1);
}

const res = await fetch("https://api.notion.com/v1/databases", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: "🫀 AI 실행상태" } }],
    properties: {
      "AI이름": { title: {} },
      "실행상태": {
        select: {
          options: [
            { name: "대기", color: "gray" },
            { name: "작업중", color: "blue" },
            { name: "완료", color: "green" },
            { name: "오류·중단", color: "red" }
          ]
        }
      },
      "현재작업명": { rich_text: {} },
      "작업시작시간": { date: {} },
      "마지막활동시간": { date: {} },
      "종료시각": { date: {} },
      "세션ID": { rich_text: {} },
      "PID": { rich_text: {} },
      "메모": { rich_text: {} }
    }
  })
});

const body = await res.json();
if (!res.ok) {
  console.error("생성 실패", res.status, JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log("생성 완료");
console.log("database_id:", body.id);
console.log("url:", body.url);
