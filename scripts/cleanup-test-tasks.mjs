// 검증용으로 만든 작업(제목에 "검증용-삭제예정")을 찾아 보관 처리한다.
//   node --env-file=.env scripts/cleanup-test-tasks.mjs          (목록만 보여줌)
//   node --env-file=.env scripts/cleanup-test-tasks.mjs --archive (실제 보관)

const BASE = (process.env.BASE || "http://localhost:3210").replace(/\/+$/, "") + "/api/v1";
const KEY = (process.env.TASKS_API_KEY || "").split(",")[0].replace(/^[A-Za-z0-9_-]{1,32}:/, "");
const MARKER = "검증용-삭제예정";
const doArchive = process.argv.includes("--archive");

const call = async (method, path) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: "Bearer " + KEY } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const found = await call("GET", "/tasks?q=" + encodeURIComponent(MARKER) + "&limit=100");
const tasks = found.json.tasks || [];

if (!tasks.length) {
  console.log("남아 있는 검증용 작업이 없습니다.");
  process.exit(0);
}

console.log(tasks.length + "건 발견:");
for (const t of tasks) console.log("  - [" + (t.status || "-") + "] " + t.title + "  " + t.url);

if (!doArchive) {
  console.log("\n실제로 보관하려면 --archive 를 붙여 다시 실행하세요.");
  process.exit(0);
}

for (const t of tasks) {
  const r = await call("DELETE", "/tasks/" + t.id + "?confirm=true");
  console.log((r.status === 200 ? "보관됨 " : "실패(" + r.status + ") ") + t.title);
}
