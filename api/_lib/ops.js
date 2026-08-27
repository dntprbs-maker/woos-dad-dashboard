// 작업관리 핵심 동작. HTTP도 MCP도 이 모듈만 부른다.
//
// 여기 있는 함수는 req/res를 모르고 순수하게 데이터만 주고받는다.
// REST 라우터(api/v1/router.js)와 MCP 서버(api/mcp-server.js)가 같은 로직을 쓰도록
// 한 군데로 모아 둔 것이다. 운영 원칙(생성 전 중복검사, 서버측 필터)도 여기서 강제된다.

import {
  queryPages, queryAll, retrievePage, createPage, updatePage, appendBlocks, listBlocks
} from "./notion.js";
import {
  fieldMap, toTask, buildProperties, buildFilter, buildSorts,
  rankCandidates, decode, DONE_STATUS
} from "./tasks.js";

const DEFAULT_THRESHOLD = Number(process.env.TASKS_DUP_THRESHOLD || 0.6);
const DEFAULT_MAX_SCAN = Number(process.env.TASKS_MAX_SCAN || 300);
const DEFAULT_DONE_WINDOW_DAYS = 7;

export const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** 호출한 쪽이 상태코드로 바꿔 쓸 수 있는 오류 */
export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

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

async function findSimilar(input, options = {}) {
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

/* ------------------------------------------------------------------ 동작들 */

export async function getSchemaInfo() {
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
  return {
    ok: true,
    source: { id: src.id, mode: src.mode, notionVersion: src.version, title: src.title },
    fieldMap: map,
    properties
  };
}

/** 조건 조회. 모든 조건은 Notion 서버에서 걸린다. */
export async function listTasks(q = {}) {
  const { map, props } = await fieldMap();
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
  return {
    ok: true,
    count: tasks.length,
    has_more: !!page.has_more,
    next_cursor: page.next_cursor || null,
    appliedFilter: filter || null,
    tasks
  };
}

/** 제목·내용 기준 유사 작업 검색 */
export async function searchTasks(body = {}) {
  const title = String(body.title || body.q || "").trim();
  if (!title) throw new ApiError(400, "invalid_request", "title(또는 q)이 필요합니다");

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
  return {
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
  };
}

/**
 * 신규 생성. 기본적으로 먼저 유사 작업을 찾아 중복이면 만들지 않고 ApiError(409)를 던진다.
 * 운영 원칙("기존 작업이 있으면 새로 만들지 말고 갱신")을 API가 강제하는 자리다.
 */
export async function createTask(body = {}) {
  const { map, props } = await fieldMap();
  const { force = false, duplicateCheck, content, ...fields } = body;

  const title = fields.title ?? fields[map.title];
  if (!title || !String(title).trim()) {
    throw new ApiError(400, "invalid_request", "title(작업명)이 필요합니다");
  }

  let duplicates = null;
  if (duplicateCheck !== false && force !== true) {
    const opts = typeof duplicateCheck === "object" && duplicateCheck ? duplicateCheck : {};
    duplicates = await findSimilar(
      { title, description: fields.description, project: fields.project },
      opts
    );
    if (duplicates.matches.length) {
      throw new ApiError(409, "duplicate_candidates",
        "비슷한 기존 작업이 있습니다. 새로 만들지 말고 기존 작업을 갱신하세요.",
        {
          scope: duplicates.scope,
          threshold: duplicates.threshold,
          scanned: duplicates.scanned,
          truncated: duplicates.truncated,
          candidates: duplicates.matches.slice(0, 5),
          hint: "기존 작업을 고칠 때는 update_task / PATCH. 그래도 새로 만들어야 하면 force:true."
        });
    }
  }

  const { properties, errors } = buildProperties(fields, map, props);
  if (errors.length) throw new ApiError(400, "invalid_properties", errors.join(" / "));

  const page = await createPage(properties, content ? blocksFromText(content) : undefined);

  return {
    ok: true,
    created: true,
    duplicateCheck: duplicates
      ? { scope: duplicates.scope, threshold: duplicates.threshold, scanned: duplicates.scanned, matches: 0 }
      : { skipped: true },
    task: toTask(page, map)
  };
}

export async function getTask(id, { blocks = false } = {}) {
  if (!UUID_RE.test(String(id || ""))) {
    throw new ApiError(400, "invalid_id", "작업 ID는 Notion 페이지 UUID여야 합니다");
  }
  const { map } = await fieldMap();
  const page = await retrievePage(id);
  const task = toTask(page, map);

  if (blocks) {
    const children = await listBlocks(id);
    task.content = (children.results || [])
      .map(b => {
        const body = b[b.type];
        const rt = body && body.rich_text;
        return Array.isArray(rt) ? rt.map(x => x.plain_text || "").join("") : "";
      })
      .filter(Boolean);
  }
  return { ok: true, task };
}

export async function updateTask(id, body = {}) {
  if (!UUID_RE.test(String(id || ""))) {
    throw new ApiError(400, "invalid_id", "작업 ID는 Notion 페이지 UUID여야 합니다");
  }
  const { map, props } = await fieldMap();
  const { appendProgress, appendTo, complete, archived, ...fields } = body;

  // complete:true 는 상태=완료 + 완료일시=now 의 축약형
  if (complete === true) {
    if (map.status) fields.status = fields.status ?? DONE_STATUS;
    if (map.completedAt) fields.completedAt = fields.completedAt ?? new Date().toISOString();
  }

  // 텍스트 속성에 이어붙이기 (기존 값을 읽어 뒤에 덧붙인다)
  if (appendProgress && appendTo) {
    const propName = map[appendTo] || (props[appendTo] ? appendTo : null);
    if (!propName) throw new ApiError(400, "invalid_request", "appendTo 속성을 찾을 수 없습니다");
    const current = decode((await retrievePage(id)).properties[propName]) || "";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    fields[propName] = (current ? current + "\n" : "") + "[" + stamp + "] " + appendProgress;
  }

  const { properties, errors } = buildProperties(fields, map, props);
  if (errors.length) throw new ApiError(400, "invalid_properties", errors.join(" / "));

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

  return {
    ok: true,
    updated: true,
    appendedToPageBody: appendedBlock,
    task: toTask(page, map)
  };
}

export async function archiveTask(id) {
  if (!UUID_RE.test(String(id || ""))) {
    throw new ApiError(400, "invalid_id", "작업 ID는 Notion 페이지 UUID여야 합니다");
  }
  const { map } = await fieldMap();
  const page = await updatePage(id, null, { archived: true });
  return { ok: true, archived: true, task: toTask(page, map) };
}
