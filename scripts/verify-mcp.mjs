// Remote MCP 서버 검증.
//
//   node --env-file=.env scripts/verify-mcp.mjs
//   BASE=https://woos-dad-dashboard.vercel.app node --env-file=.env scripts/verify-mcp.mjs
//
// dev-server.mjs 를 먼저 띄워야 로컬 검증이 된다.

const ROOT = (process.env.BASE || "http://localhost:3210").replace(/\/+$/, "");
const MCP = ROOT + "/api/mcp";
const KEY = (process.env.TASKS_API_KEY || "").split(",")[0].replace(/^[A-Za-z0-9_-]{1,32}:/, "");

if (!KEY) { console.error("TASKS_API_KEY 가 없습니다."); process.exit(1); }

let failures = 0;
let seq = 0;

async function rpc(method, params, { url = MCP, key = KEY, notification = false } = {}) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notification) body.id = ++seq;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: "Bearer " + key } : {})
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* 본문 없음 */ } }
  return { status: res.status, json };
}

function check(label, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? "  — " + detail : ""));
  if (!ok) failures++;
}

const head = (n, t) => console.log("\n" + n + ") " + t);

/** tools/call 결과에서 구조화된 payload를 꺼낸다 */
function toolPayload(r) {
  const result = r.json?.result;
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  try { return JSON.parse(result.content?.[0]?.text || "null"); } catch { return null; }
}
const isToolError = r => r.json?.result?.isError === true;

const TEST_TITLE = "[검증용-삭제예정] MCP 연결 테스트";

/* ------------------------------------------------------------ 1. 핸드셰이크 */
head(1, "핸드셰이크");
{
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify-mcp", version: "1.0.0" }
  });
  check("initialize", init.status === 200 && !!init.json?.result, "status " + init.status);
  const r = init.json?.result;
  check("프로토콜 버전 협상", r?.protocolVersion === "2025-06-18", r?.protocolVersion);
  check("tools 능력 광고", !!r?.capabilities?.tools, JSON.stringify(r?.capabilities));
  check("serverInfo", r?.serverInfo?.name === "woos-tasks", r?.serverInfo?.name);
  check("instructions에 운영 규칙 포함", (r?.instructions || "").includes("search_tasks"),
        (r?.instructions || "").split("\n")[0]);

  const old = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {} });
  check("구버전 클라이언트도 수용", old.json?.result?.protocolVersion === "2024-11-05",
        old.json?.result?.protocolVersion);

  const note = await rpc("notifications/initialized", undefined, { notification: true });
  check("알림에는 202 + 빈 본문", note.status === 202 && note.json === null, "status " + note.status);

  const ping = await rpc("ping");
  check("ping", ping.status === 200 && !!ping.json?.result, "status " + ping.status);
}

/* ------------------------------------------------------------------ 2. 인증 */
head(2, "인증");
{
  const noKey = await rpc("tools/list", undefined, { key: null });
  check("키 없으면 401", noKey.status === 401, "status " + noKey.status);

  const badKey = await rpc("tools/list", undefined, { key: "wrong-key-0123456789abcdef" });
  check("틀린 키는 401", badKey.status === 401, "status " + badKey.status);

  // 헤더를 못 넣는 클라이언트용 — 경로에 키를 넣는 방식
  const viaPath = await rpc("tools/list", undefined, { url: MCP + "/" + KEY, key: null });
  check("경로에 키를 넣어도 인증됨", viaPath.status === 200 && !!viaPath.json?.result,
        "status " + viaPath.status);
}

/* ------------------------------------------------------------ 3. 도구 목록 */
head(3, "도구 목록");
let toolNames = [];
{
  const list = await rpc("tools/list");
  toolNames = (list.json?.result?.tools || []).map(t => t.name);
  check("tools/list", list.status === 200 && toolNames.length > 0, toolNames.length + "개");
  console.log("        " + toolNames.join(", "));

  const want = ["search_tasks", "list_tasks", "get_task", "create_task", "update_task",
                "archive_task", "get_schema", "search", "fetch"];
  const missing = want.filter(n => !toolNames.includes(n));
  check("필요한 도구가 전부 있음", missing.length === 0, missing.join(", ") || "");

  const tools = list.json?.result?.tools || [];
  const noSchema = tools.filter(t => !t.inputSchema || t.inputSchema.type !== "object");
  check("모든 도구에 inputSchema", noSchema.length === 0, noSchema.map(t => t.name).join(", "));

  const create = tools.find(t => t.name === "create_task");
  check("create_task는 쓰기 도구로 표시", create?.annotations?.readOnlyHint === false, "");
  const archive = tools.find(t => t.name === "archive_task");
  check("archive_task는 파괴적 도구로 표시", archive?.annotations?.destructiveHint === true, "");
}

/* ------------------------------------------------------------ 4. 읽기 도구 */
head(4, "읽기 도구");
let sampleTask = null;
{
  const schema = await rpc("tools/call", { name: "get_schema", arguments: {} });
  const s = toolPayload(schema);
  check("get_schema", !!s?.source?.title, s?.source?.title);

  const open = await rpc("tools/call", { name: "list_tasks", arguments: { open: true, limit: 5 } });
  const o = toolPayload(open);
  check("list_tasks (open=true)", o?.ok === true && Array.isArray(o.tasks), o?.count + "건");
  check("완료 항목이 섞이지 않음", (o?.tasks || []).every(t => t.status !== "완료"), "");
  sampleTask = o?.tasks?.[0] || null;

  const done7 = await rpc("tools/call", {
    name: "list_tasks",
    arguments: { status: "완료", completedSince: "7d", sort: "-완료일시", limit: 10 }
  });
  check("list_tasks (완료 + 최근 7일)", toolPayload(done7)?.ok === true,
        toolPayload(done7)?.count + "건");

  if (sampleTask) {
    const sim = await rpc("tools/call", {
      name: "search_tasks",
      arguments: { title: sampleTask.title, scope: "open", limit: 5 }
    });
    const p = toolPayload(sim);
    check("search_tasks가 기존 작업을 찾음",
          (p?.matches || []).some(m => m.id === sampleTask.id),
          "최고점 " + (p?.matches?.[0]?.score ?? "-"));

    const got = await rpc("tools/call", { name: "get_task", arguments: { id: sampleTask.id } });
    check("get_task", toolPayload(got)?.task?.id === sampleTask.id, "");
  }
}

/* ------------------------------- 5. ChatGPT 딥리서치용 search / fetch */
head(5, "search / fetch (ChatGPT 딥리서치 호환)");
if (sampleTask) {
  const sr = await rpc("tools/call", { name: "search", arguments: { query: sampleTask.title } });
  const sp = toolPayload(sr);
  check("search가 results 배열을 돌려줌", Array.isArray(sp?.results), (sp?.results || []).length + "건");
  check("results 항목에 id·title·url", !!sp?.results?.[0]?.id && !!sp?.results?.[0]?.title && !!sp?.results?.[0]?.url, "");
  check("찾던 작업이 결과에 있음", (sp?.results || []).some(r => r.id === sampleTask.id), "");

  const fr = await rpc("tools/call", { name: "fetch", arguments: { id: sampleTask.id } });
  const fp = toolPayload(fr);
  check("fetch가 id·title·text·url을 돌려줌",
        !!fp?.id && !!fp?.title && typeof fp?.text === "string" && !!fp?.url, "");
  check("fetch text에 작업명이 들어 있음", (fp?.text || "").includes("작업명"), "");
}

/* ------------------------------------------------------------ 6. 쓰기 도구 */
head(6, "쓰기 도구");
let createdId = null;
{
  const created = await rpc("tools/call", {
    name: "create_task",
    arguments: {
      title: TEST_TITLE,
      description: "MCP 연결 검증용 임시 작업. 검증 후 보관됩니다.",
      status: "진행중",
      priority: "하",
      project: "woos-dad-dashboard",
      enteredBy: "Claude Code"
    }
  });
  const c = toolPayload(created);
  check("create_task", c?.created === true && !!c?.task?.id, c?.error || "");
  createdId = c?.task?.id || null;
  if (createdId) console.log("        " + c.task.url);

  await new Promise(r => setTimeout(r, 1200));

  const dup = await rpc("tools/call", { name: "create_task", arguments: { title: TEST_TITLE } });
  check("중복은 isError로 거절", isToolError(dup) && toolPayload(dup)?.code === "duplicate_candidates",
        toolPayload(dup)?.code + ", 후보 " + (toolPayload(dup)?.candidates?.length ?? 0) + "건");
  check("거절 응답에 후보 목록이 들어 있음", (toolPayload(dup)?.candidates || []).length > 0,
        toolPayload(dup)?.candidates?.[0]?.title || "");

  if (createdId) {
    const upd = await rpc("tools/call", {
      name: "update_task",
      arguments: {
        id: createdId,
        decision: "MCP로도 같은 원장을 쓴다",
        appendProgress: "MCP 도구 호출로 수정함",
        appendTo: "description"
      }
    });
    const u = toolPayload(upd);
    check("update_task", u?.updated === true, u?.error || "");
    check("결정사항 반영", u?.task?.decision === "MCP로도 같은 원장을 쓴다", u?.task?.decision);
    check("진행내용 덧붙음", (u?.task?.description || "").includes("MCP 도구 호출로 수정함"), "");

    const done = await rpc("tools/call", { name: "update_task", arguments: { id: createdId, complete: true } });
    const d = toolPayload(done);
    check("complete=true", d?.task?.status === "완료" && !!d?.task?.completedAt,
          d?.task?.status + " / " + d?.task?.completedAt);
  }
}

/* ------------------------------------------------------------- 7. 오류 처리 */
head(7, "오류 처리");
{
  const unknown = await rpc("tools/call", { name: "없는도구", arguments: {} });
  check("없는 도구는 isError", isToolError(unknown), toolPayload(unknown)?.code);

  const badArgs = await rpc("tools/call", { name: "search_tasks", arguments: {} });
  check("필수 인자 누락은 isError", isToolError(badArgs), toolPayload(badArgs)?.code);

  const badId = await rpc("tools/call", { name: "get_task", arguments: { id: "이상한거" } });
  check("잘못된 ID는 isError", isToolError(badId), toolPayload(badId)?.code);

  const noConfirm = await rpc("tools/call", { name: "archive_task", arguments: { id: createdId || "x" } });
  check("archive_task는 confirm 없으면 거절", isToolError(noConfirm), toolPayload(noConfirm)?.code);

  const badMethod = await rpc("존재하지않는메서드");
  check("없는 메서드는 JSON-RPC -32601", badMethod.json?.error?.code === -32601, badMethod.json?.error?.code);

  const getRes = await fetch(MCP, { headers: { Authorization: "Bearer " + KEY } });
  check("GET은 405", getRes.status === 405, "status " + getRes.status);
}

/* ------------------------------------------------------------------ 8. 정리 */
head(8, "정리");
if (createdId) {
  const arch = await rpc("tools/call", { name: "archive_task", arguments: { id: createdId, confirm: true } });
  check("archive_task (confirm=true)", toolPayload(arch)?.archived === true, "");

  await new Promise(r => setTimeout(r, 1200));
  const left = await rpc("tools/call", {
    name: "list_tasks", arguments: { q: "검증용-삭제예정", limit: 10 }
  });
  check("남은 검증용 작업 없음", toolPayload(left)?.count === 0, toolPayload(left)?.count + "건 남음");
}

console.log("\n" + (failures === 0 ? "전부 통과" : failures + "건 실패"));
process.exit(failures === 0 ? 0 : 1);
