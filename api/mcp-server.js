// Remote MCP 서버 (Streamable HTTP 전송)
//
//   POST /api/mcp            JSON-RPC 2.0 요청
//   POST /api/mcp/<키>       헤더를 못 넣는 클라이언트용 (ChatGPT 커넥터 등)
//   GET  /api/mcp            405 — 서버가 먼저 말을 거는 스트림은 쓰지 않는다
//
// 상태를 들고 있지 않다(stateless). 서버리스에서 인스턴스가 갈려도 상관없다.
// 실제 동작은 _lib/ops.js — REST API(/api/v1)와 완전히 같은 코드를 쓴다.
//
// 인증: Authorization: Bearer <TASKS_API_KEY> 또는 경로 마지막 조각에 키.
// 비밀값은 로그에 남기지 않는다.

import { authenticate, newRequestId, readJson, log } from "./_lib/http.js";
import { NotionError } from "./_lib/notion.js";
import {
  ApiError, getSchemaInfo, listTasks, searchTasks, createTask, getTask, updateTask, archiveTask
} from "./_lib/ops.js";

const SERVER_INFO = { name: "woos-tasks", title: "공용 작업관리", version: "1.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// 초롱이를 비롯한 클라이언트가 연결 직후 읽는 운영 규칙.
const INSTRUCTIONS = [
  "Notion `작업·업무협업` DB를 여러 AI가 함께 쓰는 공용 작업 원장이다.",
  "",
  "지켜야 할 순서:",
  "1. 새 작업을 만들기 전에 반드시 search_tasks 로 기존 작업을 먼저 확인한다.",
  "2. 비슷한 작업이 있으면 create_task 대신 update_task 로 기존 작업을 갱신한다.",
  "3. create_task 가 duplicate_candidates 로 거절하면 force 로 다시 시도하지 말고,",
  "   후보를 사람에게 보여 주고 어느 작업을 갱신할지 물어본다.",
  "4. 진행 상황은 update_task 의 appendProgress 로 덧붙인다. 기존 내용을 지우지 않는다.",
  "5. 작업을 끝냈으면 update_task 에 complete=true 를 준다 (상태=완료 + 완료일시 기록).",
  "",
  "조회는 전부 서버에서 걸린다. 전체를 받아오지 말고 조건을 줘라.",
  "기본 중복검색 범위는 상태!=완료 이고, 최근 완료까지 봐야 하면 scope=both 를 쓴다.",
  "상태는 대기/진행중/완료/보류, 우선순위는 상/중/하 다."
].join("\n");

/* -------------------------------------------------------------- 도구 정의 */

const TASK_FIELD_PROPS = {
  title: { type: "string", description: "작업명" },
  description: { type: "string", description: "작업내용" },
  status: { type: "string", enum: ["대기", "진행중", "완료", "보류"], description: "상태" },
  priority: { type: "string", enum: ["상", "중", "하"], description: "우선순위" },
  project: { type: "string", description: "프로젝트명" },
  assignee: { type: "string", description: "수행자 (아빠/초롱이/별이/Claude Code/Codex/사람/기타)" },
  requester: { type: "string", description: "의뢰자" },
  enteredBy: { type: "string", description: "입력자 — 이 작업을 등록한 AI나 사람" },
  decision: { type: "string", description: "결정사항" },
  note: { type: "string", description: "비고" },
  commit: { type: "string", description: "Git Commit" },
  relatedFiles: { type: "string", description: "관련파일" },
  workDate: { type: "string", description: "작업일 (YYYY-MM-DD)" },
  duration: { type: "string", description: "작업시간" },
  collabType: { type: "string", enum: ["단독 작업", "공동 작업"], description: "협업형태" },
  needsCheck: { type: "boolean", description: "확인필요" }
};

const TOOLS = [
  {
    name: "search_tasks",
    title: "유사 작업 검색",
    description:
      "제목·내용이 비슷한 기존 작업을 찾는다. 새 작업을 만들기 전에 반드시 먼저 부를 것. " +
      "기본 범위는 상태!=완료이고, 최근 완료된 것까지 보려면 scope=both 를 준다.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "찾으려는 작업 제목" },
        description: { type: "string", description: "작업내용 (있으면 정확도가 올라간다)" },
        project: { type: "string", description: "프로젝트명" },
        scope: {
          type: "string",
          enum: ["open", "recent-done", "both", "all"],
          description: "open=미완료만(기본) / recent-done=최근 완료 / both=둘 다 / all=전체"
        },
        completedWithinDays: { type: "integer", description: "recent-done·both에서 최근 며칠 (기본 7)" },
        threshold: { type: "number", description: "유사도 임계값 0~1 (기본 0.6)" },
        limit: { type: "integer", description: "최대 결과 수 (기본 10)" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "list_tasks",
    title: "작업 조건 조회",
    description:
      "조건에 맞는 작업을 조회한다. 조건은 전부 Notion 서버에서 걸리므로 전체를 받아오지 말 것. " +
      "미완료 목록은 open=true, 최근 완료는 status=완료 + completedSince=7d.",
    inputSchema: {
      type: "object",
      properties: {
        open: { type: "boolean", description: "true면 상태!=완료만" },
        status: { type: "string", description: "쉼표 구분. 예: 진행중,대기" },
        statusNot: { type: "string", description: "쉼표 구분 제외 상태" },
        q: { type: "string", description: "작업명 부분일치" },
        project: { type: "string", description: "프로젝트명 부분일치" },
        assignee: { type: "string", description: "수행자" },
        priority: { type: "string", description: "상/중/하" },
        completedSince: { type: "string", description: "완료일시 이후. '7d' 또는 '2026-08-20'" },
        workDateSince: { type: "string" },
        workDateUntil: { type: "string" },
        updatedSince: { type: "string", description: "최종수정 이후" },
        sort: { type: "string", description: "예: -완료일시 / -last_edited_time" },
        limit: { type: "integer", description: "기본 25, 최대 100" },
        cursor: { type: "string", description: "다음 페이지 커서" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "get_task",
    title: "작업 단건 조회",
    description: "작업 ID로 한 건을 자세히 본다. blocks=true면 페이지 본문까지 가져온다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        blocks: { type: "boolean", description: "본문까지 볼지" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "create_task",
    title: "신규 작업 생성",
    description:
      "새 작업을 만든다. 내부적으로 유사 작업을 먼저 찾아 비슷한 게 있으면 만들지 않고 거절한다. " +
      "거절당하면 force로 우기지 말고 update_task 로 기존 작업을 갱신할 것.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        ...TASK_FIELD_PROPS,
        content: { type: "string", description: "페이지 본문에 넣을 텍스트" },
        force: { type: "boolean", description: "중복검사를 건너뛴다. 사람이 명시적으로 시켰을 때만." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "update_task",
    title: "기존 작업 수정",
    description:
      "기존 작업의 상태·진행내용·결정사항 등을 고친다. " +
      "appendProgress 는 기존 내용을 지우지 않고 시각 도장과 함께 뒤에 덧붙인다. " +
      "complete=true 면 상태=완료 + 완료일시를 한 번에 기록한다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        ...TASK_FIELD_PROPS,
        completedAt: { type: "string", description: "완료일시 (ISO)" },
        complete: { type: "boolean", description: "true면 상태=완료 + 완료일시=현재시각" },
        appendProgress: { type: "string", description: "진행내용을 덧붙인다" },
        appendTo: {
          type: "string",
          description: "덧붙일 대상 속성명. 보통 'description'. 생략하면 페이지 본문에 기록"
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "archive_task",
    title: "작업 보관",
    description:
      "작업을 노션 휴지통으로 보낸다. 복구할 수 있지만 목록에서는 사라진다. " +
      "사람이 명시적으로 시켰을 때만 쓸 것.",
    inputSchema: {
      type: "object",
      required: ["id", "confirm"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        confirm: { type: "boolean", description: "true 여야 실행된다" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_schema",
    title: "DB 스키마 조회",
    description: "대상 작업 DB의 속성 목록과 선택지를 본다. 어떤 값을 넣을 수 있는지 확인할 때.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  // ── ChatGPT 딥리서치 커넥터가 기대하는 이름 (search / fetch) ────────────
  {
    name: "search",
    title: "작업 검색",
    description:
      "작업 원장에서 키워드로 작업을 찾는다. 제목 부분일치와 유사도 검색을 함께 쓴다. " +
      "결과의 id 를 fetch 에 넣으면 전문을 볼 수 있다.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "찾을 키워드나 작업 제목" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "fetch",
    title: "작업 전문 가져오기",
    description: "search 가 돌려준 id 로 작업 한 건의 전문을 가져온다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "작업 ID (Notion 페이지 UUID)" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }
];

/* -------------------------------------------------------------- 도구 실행 */

/** 작업 한 건을 사람이 읽을 수 있는 줄글로 (fetch 결과용) */
function taskToText(t) {
  const lines = [
    "작업명: " + (t.title || ""),
    t.status ? "상태: " + t.status : null,
    t.priority ? "우선순위: " + t.priority : null,
    t.project ? "프로젝트: " + t.project : null,
    t.assignee ? "수행자: " + t.assignee : null,
    t.requester ? "의뢰자: " + t.requester : null,
    t.workDate ? "작업일: " + t.workDate : null,
    t.completedAt ? "완료일시: " + t.completedAt : null,
    t.description ? "\n작업내용:\n" + t.description : null,
    t.decision ? "\n결정사항:\n" + t.decision : null,
    t.note ? "\n비고:\n" + t.note : null,
    t.commit ? "Git Commit: " + t.commit : null,
    Array.isArray(t.content) && t.content.length ? "\n본문:\n" + t.content.join("\n") : null
  ];
  return lines.filter(Boolean).join("\n");
}

async function runTool(name, args = {}) {
  switch (name) {
    case "search_tasks": return searchTasks(args);
    case "list_tasks":   return listTasks(args);
    case "get_task":     return getTask(args.id, { blocks: args.blocks === true });
    case "create_task":  return createTask(args);
    case "update_task": {
      const { id, ...rest } = args;
      return updateTask(id, rest);
    }
    case "archive_task": {
      if (args.confirm !== true) {
        throw new ApiError(400, "confirm_required", "보관하려면 confirm=true 를 줘야 합니다");
      }
      return archiveTask(args.id);
    }
    case "get_schema": return getSchemaInfo();

    case "search": {
      const query = String(args.query || "").trim();
      if (!query) throw new ApiError(400, "invalid_request", "query가 필요합니다");

      // 제목 부분일치와 유사도 검색을 합친다. 둘 다 서버측 필터를 거친다.
      const byTitle = await listTasks({ q: query, limit: 25 });
      const bySimilarity = await searchTasks({ title: query, scope: "both", threshold: 0.4, limit: 25 });

      const seen = new Set();
      const results = [];
      for (const t of [...byTitle.tasks, ...bySimilarity.matches]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        results.push({
          id: t.id,
          title: t.title || "(제목 없음)",
          url: t.url,
          status: t.status ?? null,
          project: t.project ?? null
        });
      }
      return { results };
    }

    case "fetch": {
      const { task } = await getTask(args.id, { blocks: true });
      return {
        id: task.id,
        title: task.title || "(제목 없음)",
        text: taskToText(task),
        url: task.url,
        metadata: {
          status: task.status ?? null,
          priority: task.priority ?? null,
          project: task.project ?? null,
          assignee: task.assignee ?? null,
          workDate: task.workDate ?? null,
          completedAt: task.completedAt ?? null,
          last_edited_time: task.last_edited_time ?? null
        }
      };
    }

    default:
      throw new ApiError(404, "unknown_tool", "'" + name + "' 도구는 없습니다");
  }
}

/* ------------------------------------------------------------- JSON-RPC */

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) }
});

const asToolResult = payload => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload
});

const asToolError = (code, message, extra) => ({
  content: [{
    type: "text",
    text: JSON.stringify({ ok: false, code, error: message, ...(extra || {}) }, null, 2)
  }],
  isError: true
});

async function handleRpc(message) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS
    });
  }

  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  // 능력으로 광고하지는 않지만, 넘겨짚고 부르는 클라이언트가 있어 빈 목록을 돌려준다.
  if (method === "resources/list")           return rpcResult(id, { resources: [] });
  if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
  if (method === "prompts/list")             return rpcResult(id, { prompts: [] });

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    try {
      return rpcResult(id, asToolResult(await runTool(toolName, args)));
    } catch (e) {
      // 도구 실행 실패는 프로토콜 오류가 아니라 도구 결과로 돌려준다.
      // 그래야 모델이 읽고 스스로 고쳐 다시 시도할 수 있다 (특히 중복 거절).
      if (e instanceof ApiError) return rpcResult(id, asToolError(e.code, e.message, e.extra));
      if (e instanceof NotionError) return rpcResult(id, asToolError("notion_" + e.code, e.message));
      console.error(JSON.stringify({ scope: "mcp_tool", tool: toolName, error: e.message }));
      return rpcResult(id, asToolError("internal_error", e.message));
    }
  }

  if (isNotification) return null; // notifications/* 등은 응답하지 않는다
  return rpcError(id, -32601, "지원하지 않는 메서드: " + method);
}

/* ------------------------------------------------------------ 엔트리포인트 */

// 헤더를 못 넣는 클라이언트를 위해 경로 마지막 조각의 키도 인증에 쓴다.
function withPathKey(req) {
  const url = new URL(req.url, "http://localhost");
  const fromRewrite = url.searchParams.get("mcpkey");
  const raw = fromRewrite !== null
    ? fromRewrite
    : url.pathname.replace(/^\/api\/mcp\/?/, "");

  const key = raw.split("/").filter(Boolean).pop();
  if (!key || req.headers.authorization || req.headers["x-api-key"]) return req;

  return new Proxy(req, {
    get(target, prop) {
      if (prop === "headers") return { ...target.headers, authorization: "Bearer " + key };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}

export default async function handler(req, res) {
  const rid = newRequestId();
  const started = Date.now();

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // 서버가 먼저 말을 거는 SSE 스트림은 제공하지 않는다. 스펙상 405가 정답이다.
  if (req.method === "GET") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "이 서버는 POST만 받습니다" } });
    return;
  }
  // 세션을 안 들고 있으므로 종료 요청은 그냥 받아준다.
  if (req.method === "DELETE") { res.status(204).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "POST만 받습니다" } });
    return;
  }

  const authed = withPathKey(req);
  const auth = authenticate(authed);
  if (!auth.ok) {
    log({ rid, method: "POST", route: "/api/mcp", status: auth.status, code: auth.code, ms: Date.now() - started });
    res.status(auth.status).json(rpcError(null, -32001, auth.error));
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    res.status(400).json(rpcError(null, -32700, e.message));
    return;
  }

  try {
    // 배치(JSON-RPC 배열)는 최신 스펙에서 빠졌지만 보내는 클라이언트가 있어 받아 준다.
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      log({ rid, method: "POST", route: "/api/mcp", status: out.length ? 200 : 202,
            ms: Date.now() - started, key: auth.label, code: "batch" });
      if (!out.length) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }

    const out = await handleRpc(body);
    log({ rid, method: "POST", route: "/api/mcp", status: out ? 200 : 202, code: body?.method,
          ms: Date.now() - started, key: auth.label });

    if (!out) { res.status(202).end(); return; } // 알림에는 본문 없이 202
    res.status(200).json(out);
  } catch (e) {
    console.error(JSON.stringify({ rid, scope: "mcp", error: e.message }));
    res.status(500).json(rpcError(body?.id ?? null, -32603, e.message));
  }
}
