// 실제 노션 DB를 대상으로 한 검증 시나리오.
//
//   조회 -> 조건 필터 조회 -> 유사 작업 검색 -> 테스트 작업 생성 -> 수정 -> 정리
//   + REST 조회를 반복해도 MCP query_data_sources 같은 사용량 한도에 안 걸리는지 확인
//
// 사용법:
//   node --env-file=.env.local scripts/verify.mjs
//   (BASE 미지정 시 http://localhost:3210 — dev-server.mjs 를 먼저 띄운다)
//   배포본 검증: BASE=https://woos-dad-dashboard.vercel.app node --env-file=.env.local scripts/verify.mjs

const BASE = (process.env.BASE || "http://localhost:3210").replace(/\/+$/, "") + "/api/v1";
const KEY = (process.env.TASKS_API_KEY || "").split(",")[0].replace(/^[A-Za-z0-9_-]{1,32}:/, "");

if (!KEY) {
  console.error("TASKS_API_KEY 가 없습니다.");
  process.exit(1);
}

let failures = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + KEY,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json;
  try { json = await res.json(); } catch { json = { raw: "<non-json>" }; }
  return { status: res.status, json };
}

function check(label, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? "  — " + detail : ""));
  if (!ok) failures++;
}

function head(n, title) {
  console.log("\n" + n + ") " + title);
}

const TEST_TITLE = "[검증용-삭제예정] 공용 작업관리 API 연결 테스트";

/* ------------------------------------------------------------------ 0. health */
head(0, "health / schema");
{
  const h = await call("GET", "/health");
  check("GET /health", h.status === 200 && h.json.ok === true, "status " + h.status);

  const noKey = await fetch(BASE + "/tasks");
  check("인증 없이 /tasks 는 401", noKey.status === 401, "status " + noKey.status);

  const badKey = await fetch(BASE + "/tasks", { headers: { Authorization: "Bearer wrong-key-0123456789" } });
  check("틀린 키는 401", badKey.status === 401, "status " + badKey.status);

  const s = await call("GET", "/schema");
  check("GET /schema", s.status === 200 && s.json.ok === true, "status " + s.status);
  if (s.json.ok) {
    console.log("        대상 DB: " + s.json.source.title + " (" + s.json.source.mode + ", " + s.json.source.notionVersion + ")");
    console.log("        속성 " + Object.keys(s.json.properties).length + "개 / 매핑된 정규필드 " + Object.keys(s.json.fieldMap).length + "개");
  }
}

/* ------------------------------------------------------------------ 1. 조회 */
head(1, "조회");
{
  const r = await call("GET", "/tasks?limit=5");
  check("GET /tasks?limit=5", r.status === 200 && Array.isArray(r.json.tasks), "status " + r.status + ", count " + r.json.count);
  if (r.json.tasks?.length) {
    console.log("        예: " + r.json.tasks.slice(0, 3).map(t => t.title).join(" / "));
  }
}

/* ------------------------------------------------- 2. 조건 필터 조회 (서버측) */
head(2, "조건 필터 조회");
{
  const open = await call("GET", "/tasks?open=true&limit=100");
  check("open=true (상태 != 완료)", open.status === 200, "미완료 " + open.json.count + "건");
  const leaked = (open.json.tasks || []).filter(t => t.status === "완료");
  check("결과에 완료 항목이 섞이지 않음", leaked.length === 0, leaked.length + "건 섞임");

  const done7 = await call("GET", "/tasks?status=" + encodeURIComponent("완료") + "&completedSince=7d&sort=-" + encodeURIComponent("완료일시") + "&limit=20");
  check("완료 AND 완료일시 >= 최근 7일", done7.status === 200, "최근 완료 " + done7.json.count + "건");

  const proj = await call("GET", "/tasks?project=" + encodeURIComponent("대시보드") + "&limit=10");
  check("프로젝트명 부분일치", proj.status === 200, proj.json.count + "건");

  const paged = await call("GET", "/tasks?limit=2");
  check("페이지네이션 커서 제공", paged.status === 200 && (paged.json.has_more === false || !!paged.json.next_cursor),
        "has_more=" + paged.json.has_more);
}

/* ------------------------------------------------------- 3. 유사 작업 검색 */
head(3, "유사 작업 검색");
{
  const r = await call("POST", "/tasks/search", { title: TEST_TITLE, scope: "both", limit: 5 });
  check("POST /tasks/search", r.status === 200, "훑은 건수 " + r.json.scanned + ", 매치 " + r.json.totalMatches);
  check("아직 없는 작업이라 매치 0건", r.json.totalMatches === 0,
        (r.json.matches || []).map(m => m.score + " " + m.title).join(" | "));

  // 이미 있는 작업 제목으로 검색하면 반드시 잡혀야 한다
  const any = await call("GET", "/tasks?open=true&limit=1");
  const sample = any.json.tasks?.[0];
  if (sample) {
    const hit = await call("POST", "/tasks/search", { title: sample.title, scope: "open", limit: 5 });
    const found = (hit.json.matches || []).some(m => m.id === sample.id);
    check("기존 작업 제목으로 검색하면 그 작업이 잡힘", found,
          "최고점 " + (hit.json.matches?.[0]?.score ?? "-") + " / " + (hit.json.matches?.[0]?.title ?? "없음"));
  } else {
    console.log("        (미완료 작업이 없어 이 검사는 건너뜀)");
  }
}

/* ------------------------------------------------------- 4. 테스트 작업 생성 */
head(4, "테스트 작업 생성 + 중복 차단");
let createdId = null;
{
  const r = await call("POST", "/tasks", {
    title: TEST_TITLE,
    description: "REST API 검증용으로 만든 임시 작업입니다. 검증이 끝나면 보관 처리됩니다.",
    status: "진행중",
    priority: "하",
    project: "woos-dad-dashboard",
    enteredBy: "Claude Code"
  });
  check("POST /tasks 생성", r.status === 201 && r.json.ok, "status " + r.status + " " + (r.json.error || ""));
  createdId = r.json.task?.id || null;
  if (createdId) console.log("        생성된 작업: " + r.json.task.url);

  // 간격 0초 재생성은 막지 않는다 — 노션 인덱스가 아직 첫 건을 못 봤기 때문. 문서에 적힌 한계다.
  const dup = await call("POST", "/tasks", { title: TEST_TITLE, status: "대기" });
  console.log("        [알려진 한계] 간격 0초 재생성 → status " + dup.status +
              (dup.status === 201 ? " (노션 인덱스 반영 전이라 통과. 1초 뒤 시도는 4b에서 차단 확인)" : " (차단됨)"));
  if (dup.status === 201 && dup.json.task?.id) {
    await call("DELETE", "/tasks/" + dup.json.task.id + "?confirm=true");
    console.log("        └ 만들어진 중복은 정리했습니다");
  }

  // 거의 같은 제목도 잡혀야 한다
  const near = await call("POST", "/tasks", { title: "공용 작업관리 API 연결 테스트 [검증용-삭제예정]" });
  check("유사 제목도 409로 차단", near.status === 409,
        "status " + near.status + ", 최고점 " + (near.json.candidates?.[0]?.score ?? "-"));
}

/* ------------------------ 4b. 다른 AI가 1초 뒤에 같은 작업을 만들려 할 때 */
// 노션 쿼리 인덱스 반영이 0.5초쯤 걸린다. 그 뒤에 들어온 요청은 반드시 막혀야 한다.
head("4b", "1초 뒤 같은 제목 생성 시도");
{
  const T = "[검증용-삭제예정] 인덱스 반영 뒤 중복 시도";
  const first = await call("POST", "/tasks", { title: T, enteredBy: "초롱이" });
  check("첫 번째 생성", first.status === 201, "status " + first.status);

  await new Promise(r => setTimeout(r, 1000));

  const second = await call("POST", "/tasks", { title: T, enteredBy: "별이" });
  check("1초 뒤 같은 제목은 409로 차단", second.status === 409,
        "status " + second.status + ", 최고점 " + (second.json.candidates?.[0]?.score ?? "-"));

  await new Promise(r => setTimeout(r, 1000));
  const left = await call("GET", "/tasks?q=" + encodeURIComponent("인덱스 반영 뒤 중복 시도") + "&limit=10");
  check("노션에 실제로 1건만 남음", left.json.count === 1, left.json.count + "건 남음");

  for (const t of left.json.tasks || []) await call("DELETE", "/tasks/" + t.id + "?confirm=true");
}

/* ------------------------------------------------------------------ 5. 수정 */
head(5, "기존 작업 수정");
if (createdId) {
  const r = await call("PATCH", "/tasks/" + createdId, {
    status: "진행중",
    decision: "REST API 방식으로 계속 간다",
    appendProgress: "조회·필터·검색·생성까지 정상 확인",
    appendTo: "description"
  });
  check("PATCH 속성 수정 + 진행내용 덧붙이기", r.status === 200 && r.json.ok, "status " + r.status + " " + (r.json.error || ""));
  check("결정사항이 반영됨", r.json.task?.decision === "REST API 방식으로 계속 간다", r.json.task?.decision);
  check("진행내용이 덧붙었음", (r.json.task?.description || "").includes("정상 확인"), "");

  const one = await call("GET", "/tasks/" + createdId);
  check("GET /tasks/{id} 단건 조회", one.status === 200 && one.json.task?.id === createdId, "status " + one.status);

  const done = await call("PATCH", "/tasks/" + createdId, { complete: true });
  check("complete:true 로 상태=완료 + 완료일시 기록", done.json.task?.status === "완료" && !!done.json.task?.completedAt,
        done.json.task?.status + " / " + done.json.task?.completedAt);
} else {
  console.log("  SKIP  생성이 실패해 수정 검사를 건너뜁니다");
  failures++;
}

/* ------------------------------- 6. 반복 조회 — 사용량 한도에 걸리지 않는지 */
head(6, "REST 조회 반복 (MCP query_data_sources 한도와 별개인지)");
{
  const N = 20;
  const codes = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = await call("GET", "/tasks?open=true&limit=5");
    codes.push(r.status);
    if (r.status !== 200) {
      console.log("        " + (i + 1) + "번째에서 실패: " + JSON.stringify(r.json).slice(0, 200));
      break;
    }
  }
  const allOk = codes.length === N && codes.every(c => c === 200);
  check("연속 " + N + "회 조회 전부 성공", allOk,
        codes.filter(c => c === 200).length + "/" + N + " 성공, " + (Date.now() - t0) + "ms");
}

/* ------------------------------------------------------------------ 7. 정리 */
head(7, "테스트 작업 정리");
if (createdId) {
  const r = await call("DELETE", "/tasks/" + createdId + "?confirm=true");
  check("DELETE ?confirm=true 로 보관", r.status === 200 && r.json.archived === true, "status " + r.status);

  const guard = await call("DELETE", "/tasks/" + createdId);
  check("confirm 없으면 거부", guard.status === 400, "status " + guard.status);
}

console.log("\n" + (failures === 0 ? "전부 통과" : failures + "건 실패"));
process.exit(failures === 0 ? 0 : 1);
