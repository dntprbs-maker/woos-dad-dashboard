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
// ChatGPT / Claude / Claude Code / n8n 등이 같은 원장을 공유한다.

import {
  authenticate, send, fail, log, newRequestId, readJson, applyCors
} from "../_lib/http.js";
import {
  getSource, queryPages, queryAll, retrievePage, createPage, updatePage,
  appendBlocks, listBlocks, NotionError
} from "../_lib/notion.js";
import {
  fieldMap, toTask, buildProperties, buildFilter, buildSorts,
  rankCandidates, normalizeSince, decode, DONE_STATUS
} from "../_lib/tasks.js";
import { openapi } from "../_lib/openapi.js";

const DEFAULT_THRESHOLD = Number(process.env.TASKS_DUP_THRESHOLD || 0.6);
const DEFAULT_MAX_SCAN = Number(process.env.TASKS_MAX_SCAN || 300);
const DEFAULT_DONE_WINDOW_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// 알려진 한계: 노션 쿼리 인덱스는 즉시 일관되지 않는다. 실측하면 방금 만든 페이지가
// 조회에 잡히기까지 title 부분일치 221ms, 전체 스캔 558ms 걸린다. 그 0.5초 안에
// 같은 제목으로 두 요청이 들어오면 둘 다 중복검사를 통과한다.
// 사람이나 AI가 대화 중 작업을 만드는 속도로는 겹치지 않아 그대로 둔다.
// (자동화가 같은 트리거로 동시에 쏘는 경우라면 호출하는 쪽에서 직렬화할 것)

/* ------------------------------------------------------------------ 유틸 */

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

function blocksFromText(text) {
  return String(text)
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map(content => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }] }
    }));
}

/** 중복검색 범위(scope) -> Notion filter */
function scopeFilter(scope, map, props, doneWindowDays) {
  const statusProp = map.status;
  const doneProp = map.completedAt;
  const since = new Date(Date.now() - doneWindowDays * 86400000).toISOString();
  const s = statusProp ? props[statusProp] : null;
  const key = s && s.type === "status" ? "status" : "select";

  const notDone = statusProp ? { property: statusProp, [key]: { does_not_equal: DONE_STATUS } } : null;
  const isDone = statusProp ? { property: statusProp, [key]: { equals: DONE_STATUS } } : null;
  const recentlyDone = doneProp && isDone
    ? { and: [isDone, { property: doneProp, date: { on_or_after: since } }] }
    : isDone;

  switch (scope) {
    case "all":         return undefined;
    case "recent-done": return recentlyDone || undefined;
    case "both":        return notDone && recentlyDone ? { or: [notDone, recentlyDone] } : (notDone || undefined);
    case "open":
    default:            return notDone || undefined;
  }
}

async function findSimilar(input, options) {
  const { map, props } = await fieldMap();
  const scope = options.scope || "open";
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
  const maxScan = Math.min(1000, Math.max(1, options.maxScan || DEFAULT_MAX_SCAN));
  const doneWindowDays = options.completedWithinDays || DEFAULT_DONE_WINDOW_DAYS;

  const filter = scopeFilter(scope, map, props, doneWindowDays);
  const { results, truncated, scanned } = await queryAll({ filter, maxScan });
  const tasks = results.map(p => toTask(p, map));
  const matches = rankCandidates(tasks, input, threshold);

  return { scope, threshold, scanned, truncated, matches, doneWindowDays };
}

/* ------------------------------------------------------------- 라우트 처리 */

async function handleSchema(res, rid) {
  const { src, props, map } = await fieldMap();
  const properties = {};
  for (const [name, p] of Object.entries(props)) {
    const entry = { type: p.type };
    if (p.type === "select") entry.options = p.select.options.map(o => o.name);
    if (p.type === "status") entry.options = p.status.options.map(o => o.name);
    if (p.type === "multi_select") entry.options = p.multi_select.options.map(o => o.name);
    if (p.type === "relation") entry.relation = true;
    properties[name] = entry;
  }
  send(res, 200, {
    ok: true,
    source: { id: src.id, mode: src.mode, notionVersion: src.version, title: src.title },
    fieldMap: map,
    properties
  }, rid);
}

async function handleList(req, res, rid, params) {
  const { map, props } = await fieldMap();
  const q = paramsToObject(params);

  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
  const filter = buildFilter(q, map, props);
  const sorts = buildSorts(q.sort, map, props);

  const page = await queryPages({
    filter,
    sorts,
    pageSize: limit,
    startCursor: q.cursor || undefined
  });

  const tasks = (page.results || []).map(p => toTask(p, map));
  send(res, 200, {
    ok: true,
    count: tasks.length,
    has_more: !!page.has_more,
    next_cursor: page.next_cursor || null,
    appliedFilter: filter || null,
    tasks
  }, rid);
}

async function handleSearch(req, res, rid) {
  const body = await readJson(req);
  const title = String(body.title || body.q || "").trim();
  if (!title) return fail(res, 400, "invalid_request", "title(또는 q)이 필요합니다", rid);

  const result = await findSimilar(
    { title, description: body.description, project: body.project },
    {
      scope: body.scope,
      threshold: body.threshold,
      maxScan: body.maxScan,
      completedWithinDays: body.completedWithinDays
    }
  );

  const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
  send(res, 200, {
    ok: true,
    query: { title, description: body.description ?? null, project: body.project ?? null },
    scope: result.scope,
    completedWithinDays: result.doneWindowDays,
    threshold: result.threshold,
    scanned: result.scanned,
    truncated: result.truncated,
    count: Math.min(result.matches.length, limit),
    totalMatches: result.matches.length,
    matches: result.matches.slice(0, limit)
  }, rid);
}

async function handleCreate(req, res, rid) {
  const { map, props } = await fieldMap();
  const body = await readJson(req);

  const {
    force = false,
    duplicateCheck,
    content,
    ...fields
  } = body;

  const title = fields.title ?? fields[map.title];
  if (!title || !String(title).trim()) {
    return fail(res, 400, "invalid_request", "title(작업명)이 필요합니다", rid);
  }

  // 신규 생성은 기본적으로 먼저 유사 작업을 찾아 중복을 막는다.
  let duplicates = null;
  if (duplicateCheck !== false && force !== true) {
    const opts = typeof duplicateCheck === "object" && duplicateCheck ? duplicateCheck : {};
    duplicates = await findSimilar(
      { title, description: fields.description, project: fields.project },
      opts
    );
    if (duplicates.matches.length) {
      return fail(res, 409, "duplicate_candidates",
        "비슷한 기존 작업이 있습니다. 새로 만들지 말고 기존 작업을 갱신하세요.",
        rid,
        {
          scope: duplicates.scope,
          threshold: duplicates.threshold,
          scanned: duplicates.scanned,
          truncated: duplicates.truncated,
          candidates: duplicates.matches.slice(0, 5),
          hint: "기존 작업을 고칠 때는 PATCH /api/v1/tasks/{id}. 그래도 새로 만들어야 하면 force:true."
        });
    }
  }

  const { properties, errors } = buildProperties(fields, map, props);
  if (errors.length) return fail(res, 400, "invalid_properties", errors.join(" / "), rid);

  const page = await createPage(properties, content ? blocksFromText(content) : undefined);

  send(res, 201, {
    ok: true,
    created: true,
    duplicateCheck: duplicates
      ? { scope: duplicates.scope, threshold: duplicates.threshold, scanned: duplicates.scanned, matches: 0 }
      : { skipped: true },
    task: toTask(page, map)
  }, rid);
}

async function handleGetOne(req, res, rid, id, params) {
  const { map } = await fieldMap();
  const page = await retrievePage(id);
  const task = toTask(page, map);

  if (params.get("blocks") === "true") {
    const blocks = await listBlocks(id);
    task.content = (blocks.results || [])
      .map(b => {
        const body = b[b.type];
        const rt = body && body.rich_text;
        return Array.isArray(rt) ? rt.map(x => x.plain_text || "").join("") : "";
      })
      .filter(Boolean);
  }
  send(res, 200, { ok: true, task }, rid);
}

async function handleUpdate(req, res, rid, id) {
  const { map, props } = await fieldMap();
  const body = await readJson(req);

  const {
    appendProgress,
    appendTo,
    complete,
    archived,
    ...fields
  } = body;

  // complete:true 는 상태=완료 + 완료일시=now 의 축약형
  if (complete === true) {
    if (map.status) fields.status = fields.status ?? DONE_STATUS;
    if (map.completedAt) fields.completedAt = fields.completedAt ?? new Date().toISOString();
  }

  // 텍스트 속성에 이어붙이기 (기존 값을 읽어 뒤에 덧붙인다)
  if (appendProgress && appendTo) {
    const propName = map[appendTo] || (props[appendTo] ? appendTo : null);
    if (!propName) return fail(res, 400, "invalid_request", "appendTo 속성을 찾을 수 없습니다", rid);
    const current = decode((await retrievePage(id)).properties[propName]) || "";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    fields[propName] = (current ? current + "\n" : "") + "[" + stamp + "] " + appendProgress;
  }

  const { properties, errors } = buildProperties(fields, map, props);
  if (errors.length) return fail(res, 400, "invalid_properties", errors.join(" / "), rid);

  const extra = {};
  if (typeof archived === "boolean") extra.archived = archived;

  const page = await updatePage(id, properties, extra);

  // appendTo 없이 진행내용만 주면 페이지 본문에 기록한다
  let appendedBlock = false;
  if (appendProgress && !appendTo) {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    await appendBlocks(id, blocksFromText("[" + stamp + "] " + appendProgress));
    appendedBlock = true;
  }

  send(res, 200, {
    ok: true,
    updated: true,
    appendedToPageBody: appendedBlock,
    task: toTask(page, map)
  }, rid);
}

async function handleArchive(req, res, rid, id, params) {
  if (params.get("confirm") !== "true") {
    return fail(res, 400, "confirm_required",
      "보관 처리는 ?confirm=true 가 필요합니다 (노션 휴지통으로 이동, 복구 가능)", rid);
  }
  const { map } = await fieldMap();
  const page = await updatePage(id, null, { archived: true });
  send(res, 200, { ok: true, archived: true, task: toTask(page, map) }, rid);
}

/* -------------------------------------------------------------- 엔트리포인트 */

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
      send(res, 200, { ok: true, service: "tasks-api", version: "1.0.0", time: new Date().toISOString() }, rid);
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
      await handleSchema(res, rid);
      return done(200);
    }

    if (segments[0] === "tasks") {
      const rest = segments.slice(1);

      if (rest.length === 0) {
        if (req.method === "GET")  { await handleList(req, res, rid, params); return done(200); }
        if (req.method === "POST") { await handleCreate(req, res, rid); return done(res.statusCode); }
        fail(res, 405, "method_not_allowed", "GET 또는 POST만 됩니다", rid);
        return done(405);
      }

      if (rest.length === 1 && rest[0] === "search") {
        if (req.method !== "POST") {
          fail(res, 405, "method_not_allowed", "POST만 됩니다", rid);
          return done(405);
        }
        await handleSearch(req, res, rid);
        return done(200);
      }

      if (rest.length === 1) {
        const id = rest[0];
        if (!UUID_RE.test(id)) {
          fail(res, 400, "invalid_id", "작업 ID는 Notion 페이지 UUID여야 합니다", rid);
          return done(400);
        }
        if (req.method === "GET")    { await handleGetOne(req, res, rid, id, params); return done(200); }
        if (req.method === "PATCH")  { await handleUpdate(req, res, rid, id); return done(res.statusCode); }
        if (req.method === "DELETE") { await handleArchive(req, res, rid, id, params); return done(res.statusCode); }
        fail(res, 405, "method_not_allowed", "GET, PATCH, DELETE만 됩니다", rid);
        return done(405);
      }
    }

    fail(res, 404, "not_found", "그런 경로는 없습니다", rid);
    return done(404);
  } catch (e) {
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
