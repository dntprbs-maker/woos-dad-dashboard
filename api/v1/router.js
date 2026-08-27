// 공용 작업관리 API (Notion 공식 REST API 기반)
//
//   GET    /api/v1/health
//   GET    /api/v1/schema
//   GET    /api/v1/openapi.json
//   GET    /api/v1/tasks              조건 조회 (서버측 필터)
//   POST   /api/v1/tasks              신규 생성 (내부적으로 유사 작업 검색 후 중복 차단)
//   POST   /api/v1/tasks/search       제목·내용 기준 유사 작업 검색
//   GET    /api/v1/tasks/{id}         단건 조회
//   PATCH  /api/v1/tasks/{id}         기존 작업 수정
//   DELETE /api/v1/tasks/{id}?confirm=true   보관(휴지통) 처리
//
// 특정 AI에 종속되지 않는 순수 HTTP+JSON 인터페이스다.
// 실제 동작은 _lib/ops.js 에 있고 MCP 서버(api/mcp-server.js)도 같은 것을 쓴다.

import {
  authenticate, send, fail, log, newRequestId, readJson, applyCors
} from "../_lib/http.js";
import { NotionError } from "../_lib/notion.js";
import {
  ApiError, UUID_RE,
  getSchemaInfo, listTasks, searchTasks, createTask, getTask, updateTask, archiveTask
} from "../_lib/ops.js";
import { getRules, updateRules } from "../_lib/rules.js";
import { openapi } from "../_lib/openapi.js";

// 알려진 한계: 노션 쿼리 인덱스는 즉시 일관되지 않는다. 실측하면 방금 만든 페이지가
// 조회에 잡히기까지 title 부분일치 221ms, 전체 스캔 558ms 걸린다. 그 0.5초 안에
// 같은 제목으로 두 요청이 들어오면 둘 다 중복검사를 통과한다.
// 사람이나 AI가 대화 중 작업을 만드는 속도로는 겹치지 않아 그대로 둔다.

// Vercel은 `api/v1/[...path].js` 캐치올로 두 단계 경로(/api/v1/tasks/search)를 받지 못했다.
// 그래서 vercel.json 의 rewrite 가 원래 경로를 ?path=tasks/search 로 넘겨준다.
// 로컬 dev-server 에는 rewrite 가 없으므로 pathname 에서 직접 잘라낸다.
function parseUrl(req) {
  const url = new URL(req.url, "http://localhost");
  const viaRewrite = url.searchParams.get("path");
  const raw = viaRewrite !== null
    ? viaRewrite
    : url.pathname.replace(/^\/api\/v1\/?/, "");

  const segments = raw.split("/").filter(Boolean).map(decodeURIComponent);
  url.searchParams.delete("path"); // 라우팅용이므로 조회 조건에서 제외한다
  return { segments, params: url.searchParams };
}

const paramsToObject = params => Object.fromEntries(params.entries());

export default async function handler(req, res) {
  const rid = newRequestId();
  const started = Date.now();
  const { segments, params } = parseUrl(req);
  const route = "/api/v1/" + segments.join("/");

  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const done = (status, code) => log({
    rid, method: req.method, route, status, code,
    ms: Date.now() - started, key: req.__keyLabel
  });

  try {
    // 인증 없이 여는 유일한 경로. 설정값은 노출하지 않는다.
    if (segments[0] === "health" && req.method === "GET") {
      send(res, 200, { ok: true, service: "tasks-api", version: "1.1.0", time: new Date().toISOString() }, rid);
      return done(200);
    }

    const auth = authenticate(req);
    if (!auth.ok) {
      fail(res, auth.status, auth.code, auth.error, rid);
      return done(auth.status, auth.code);
    }
    req.__keyLabel = auth.label;

    if (segments[0] === "openapi.json" && req.method === "GET") {
      send(res, 200, openapi(req), rid);
      return done(200);
    }

    if (segments[0] === "schema" && req.method === "GET") {
      send(res, 200, await getSchemaInfo(), rid);
      return done(200);
    }

    // 노션 운영규칙 — MCP의 get_notion_rules / update_notion_rules 와 같은 코드
    if (segments[0] === "rules" && segments.length === 1) {
      if (req.method === "GET") {
        send(res, 200, await getRules(), rid);
        return done(200);
      }
      if (req.method === "PATCH") {
        send(res, 200, await updateRules(await readJson(req)), rid);
        return done(200);
      }
      fail(res, 405, "method_not_allowed", "GET 또는 PATCH만 됩니다", rid);
      return done(405);
    }

    if (segments[0] === "tasks") {
      const rest = segments.slice(1);

      if (rest.length === 0) {
        if (req.method === "GET") {
          send(res, 200, await listTasks(paramsToObject(params)), rid);
          return done(200);
        }
        if (req.method === "POST") {
          send(res, 201, await createTask(await readJson(req)), rid);
          return done(201);
        }
        fail(res, 405, "method_not_allowed", "GET 또는 POST만 됩니다", rid);
        return done(405);
      }

      if (rest.length === 1 && rest[0] === "search") {
        if (req.method !== "POST") {
          fail(res, 405, "method_not_allowed", "POST만 됩니다", rid);
          return done(405);
        }
        send(res, 200, await searchTasks(await readJson(req)), rid);
        return done(200);
      }

      if (rest.length === 1) {
        const id = rest[0];
        if (!UUID_RE.test(id)) {
          fail(res, 400, "invalid_id", "작업 ID는 Notion 페이지 UUID여야 합니다", rid);
          return done(400);
        }
        if (req.method === "GET") {
          send(res, 200, await getTask(id, { blocks: params.get("blocks") === "true" }), rid);
          return done(200);
        }
        if (req.method === "PATCH") {
          send(res, 200, await updateTask(id, await readJson(req)), rid);
          return done(200);
        }
        if (req.method === "DELETE") {
          if (params.get("confirm") !== "true") {
            fail(res, 400, "confirm_required",
              "보관 처리는 ?confirm=true 가 필요합니다 (노션 휴지통으로 이동, 복구 가능)", rid);
            return done(400);
          }
          send(res, 200, await archiveTask(id), rid);
          return done(200);
        }
        fail(res, 405, "method_not_allowed", "GET, PATCH, DELETE만 됩니다", rid);
        return done(405);
      }
    }

    fail(res, 404, "not_found", "그런 경로는 없습니다", rid);
    return done(404);
  } catch (e) {
    if (e instanceof ApiError) {
      fail(res, e.status, e.code, e.message, rid, e.extra);
      return done(e.status, e.code);
    }
    if (e instanceof NotionError) {
      const status = e.status === 401 ? 502 : e.status; // 노션 토큰 문제를 클라이언트 인증 실패로 오해시키지 않는다
      fail(res, status, "notion_" + e.code, e.message, rid, { notionRequestId: e.requestId || null });
      return log({ rid, method: req.method, route, status, code: e.code, ms: Date.now() - started,
                   key: req.__keyLabel, notionRequestId: e.requestId });
    }
    // 예상치 못한 오류는 메시지만 남긴다. 스택/환경변수는 남기지 않는다.
    console.error(JSON.stringify({ rid, route, error: e.message }));
    fail(res, 500, "internal_error", e.message, rid);
    return log({ rid, method: req.method, route, status: 500, ms: Date.now() - started, key: req.__keyLabel });
  }
}
