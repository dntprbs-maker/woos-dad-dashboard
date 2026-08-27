// 노션 운영규칙 기능 + 기존 기능 회귀 검증 (명세 9항 10가지)
//
//   BASE=https://woos-dad-dashboard.vercel.app node --env-file=.env scripts/verify-rules.mjs
//
// 규칙 페이지는 검증 중 임시로 한 줄이 추가됐다가 원상 복구된다.

const ROOT = (process.env.BASE || "http://localhost:3210").replace(/\/+$/, "");
const MCP = ROOT + "/api/mcp";
const API = ROOT + "/api/v1";
const KEY = (process.env.TASKS_API_KEY || "").split(",").find(s => s.trim().startsWith("code:")).trim().slice(5);
const H = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

let failures = 0, seq = 0;
const check = (label, ok, detail) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? "  — " + detail : ""));
  if (!ok) failures++;
};
const head = (n, t) => console.log("\n" + n + ") " + t);

async function rpc(method, params) {
  const r = await fetch(MCP, {
    method: "POST", headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) })
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const payload = r => {
  const x = r.json?.result;
  if (!x) return null;
  if (x.structuredContent) return x.structuredContent;
  try { return JSON.parse(x.content?.[0]?.text || "null"); } catch { return null; }
};
const isErr = r => r.json?.result?.isError === true;
const rest = async (m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const EXPECTED_9 = ["search_tasks", "list_tasks", "get_task", "create_task", "update_task",
                    "archive_task", "get_schema", "search", "fetch"];
const NEW_2 = ["get_notion_rules", "update_notion_rules"];

/* ①② MCP URL·기존 도구 */
head(1, "기존 MCP URL 그대로인지 / 핸드셰이크");
{
  console.log("        URL: " + MCP);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} });
  check("initialize", init.status === 200 && !!init.json?.result, "status " + init.status);
  check("serverInfo 동일 (woos-tasks)", init.json?.result?.serverInfo?.name === "woos-tasks", init.json?.result?.serverInfo?.name);
  const ins = init.json?.result?.instructions || "";
  check("instructions에 get_notion_rules 원칙 포함", ins.includes("get_notion_rules"), "");
  check("instructions에 update 제한 명시", ins.includes("아빠가 명시적으로 규칙 변경을 지시했을 때만"), "");
}

head(2, "도구 목록 — 기존 9개 유지 + 신규 2개 = 11개");
let names = [];
{
  const l = await rpc("tools/list");
  names = (l.json?.result?.tools || []).map(t => t.name);
  console.log("        " + names.join(", "));
  const missing = EXPECTED_9.filter(n => !names.includes(n));
  check("기존 9개 전부 살아 있음", missing.length === 0, missing.join(", ") || "");
  check("신규 2개 노출", NEW_2.every(n => names.includes(n)), "");
  check("총 11개", names.length === 11, names.length + "개");

  const tools = l.json?.result?.tools || [];
  const upd = tools.find(t => t.name === "update_notion_rules");
  check("update_notion_rules 설명에 권한 제한 기재",
        (upd?.description || "").includes("아빠가 명시적으로"), "");
  check("update_notion_rules 파괴적 도구로 표시", upd?.annotations?.destructiveHint === true, "");
}

/* ④ 규칙 읽기 */
head(4, "get_notion_rules 로 실제 규칙 읽기");
let original = null;
{
  const r = await rpc("tools/call", { name: "get_notion_rules", arguments: {} });
  const p = payload(r);
  if (isErr(r)) {
    check("get_notion_rules", false, p?.code + " " + p?.error);
  } else {
    original = p;
    check("get_notion_rules", p?.ok === true && typeof p.content === "string", p?.title);
    check("15개 규칙이 들어 있음", (p?.content || "").includes("15."), "블록 " + p?.blockCount + "개");
    check("1번 규칙 확인", (p?.content || "").includes("작업·업무협업"), "");
    console.log("        페이지: " + p?.title + " / 블록 " + p?.blockCount + "개 / 수정 " + String(p?.last_edited_time).slice(0, 16));
  }
}

/* ⑤⑥⑦ 규칙 쓰기 → 즉시 반영 → 복구 */
head(5, "update_notion_rules 권한 가드 + 추가 → 즉시 반영 → 복구");
if (original) {
  const noFlag = await rpc("tools/call", {
    name: "update_notion_rules", arguments: { content: "테스트", reason: "무단 변경 시도" }
  });
  check("dadApproved 없으면 거절", isErr(noFlag) && payload(noFlag)?.code?.includes("not_authorized"),
        payload(noFlag)?.code);

  const noReason = await rpc("tools/call", {
    name: "update_notion_rules", arguments: { content: "테스트", dadApproved: true }
  });
  check("reason 없으면 거절", isErr(noReason), payload(noReason)?.code);

  const MARK = "16. [검증용-삭제예정] 프로덕션 검증 임시 규칙";
  const added = await rpc("tools/call", {
    name: "update_notion_rules",
    arguments: { mode: "append", content: MARK, dadApproved: true, reason: "아빠가 지시한 프로덕션 검증 절차" }
  });
  const a = payload(added);
  check("append 로 테스트 규칙 추가", a?.updated === true, a?.error || "");
  check("서버가 반영 여부를 자체 검증", a?.verified === true,
        "블록 " + a?.blockCountBefore + " → " + a?.blockCountAfter);

  const reread = await rpc("tools/call", { name: "get_notion_rules", arguments: {} });
  check("다시 읽으면 즉시 반영됨", (payload(reread)?.content || "").includes("검증용-삭제예정"), "");

  const restored = await rpc("tools/call", {
    name: "update_notion_rules",
    arguments: { mode: "replace", content: original.content, dadApproved: true, reason: "검증 후 원상 복구" }
  });
  const rr = payload(restored);
  check("replace 로 원상 복구", rr?.updated === true && rr?.verified === true,
        "블록 " + rr?.blockCountAfter + "개");

  const final = payload(await rpc("tools/call", { name: "get_notion_rules", arguments: {} }));
  check("테스트 규칙이 사라짐", !(final?.content || "").includes("검증용-삭제예정"), "");
  check("원래 내용과 일치", final?.content === original.content,
        final?.content === original.content ? "" : "차이 있음");
} else {
  console.log("  SKIP  규칙을 못 읽어 쓰기 검증을 건너뜁니다");
  failures++;
}

/* ⑧⑨⑩ 기존 기능 회귀 */
head(8, "기존 기능 회귀 — 조회 / 생성·수정 / 중복방지");
{
  const open = payload(await rpc("tools/call", { name: "list_tasks", arguments: { open: true, limit: 5 } }));
  check("작업 조회 정상", open?.ok === true && Array.isArray(open.tasks), open?.count + "건");

  const done7 = payload(await rpc("tools/call", {
    name: "list_tasks", arguments: { status: "완료", completedSince: "7d", limit: 10 }
  }));
  check("서버측 조건 조회(최근 완료) 정상", done7?.ok === true, done7?.count + "건");

  const T = "[검증용-삭제예정] 운영규칙 기능 회귀 테스트";
  const created = payload(await rpc("tools/call", {
    name: "create_task",
    arguments: { title: T, status: "진행중", project: "woos-dad-dashboard", enteredBy: "Claude Code" }
  }));
  check("작업 생성 정상", created?.created === true, created?.error || "");
  const id = created?.task?.id;

  await new Promise(r => setTimeout(r, 1200));
  const dup = await rpc("tools/call", { name: "create_task", arguments: { title: T } });
  check("중복방지 로직 정상", isErr(dup) && payload(dup)?.code === "duplicate_candidates", payload(dup)?.code);

  if (id) {
    const upd = payload(await rpc("tools/call", {
      name: "update_task", arguments: { id, decision: "회귀 테스트 통과", complete: true }
    }));
    check("작업 수정 정상", upd?.updated === true, "");
    check("완료 처리 시 완료일시 기록", !!upd?.task?.completedAt, upd?.task?.completedAt);
    await rpc("tools/call", { name: "archive_task", arguments: { id, confirm: true } });
  }

  const r = await rest("GET", "/tasks?open=true&limit=3");
  check("REST /api/v1 도 그대로 동작", r.status === 200 && r.json.ok === true, "status " + r.status);
  const rr = await rest("GET", "/rules");
  check("REST /api/v1/rules 동작", rr.status === 200 && rr.json.ok === true, "status " + rr.status);
}

head(9, "잔여 정리");
{
  const left = payload(await rpc("tools/call", {
    name: "list_tasks", arguments: { q: "검증용-삭제예정", limit: 10 }
  }));
  check("남은 검증용 작업 없음", left?.count === 0, left?.count + "건");
}

console.log("\n" + (failures === 0 ? "전부 통과" : failures + "건 실패"));
process.exit(failures === 0 ? 0 : 1);
