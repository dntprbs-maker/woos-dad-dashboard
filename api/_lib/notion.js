// Notion 공식 REST API 클라이언트 (의존성 없음, fetch 기반)
//
// - Notion MCP의 query_data_sources 사용량 한도와 무관한 경로다.
//   REST API에는 월 한도가 없고 초당 평균 3요청의 rate limit만 있다.
// - 2022-06-28(databases) / 2025-09-03(data_sources) 두 세대를 모두 지원한다.
//   환경변수로 받은 ID가 어느 쪽인지 런타임에 판별한다.
// - 토큰은 절대 로그로 내보내지 않는다.

const API = "https://api.notion.com/v1";
const LEGACY_VERSION = "2022-06-28";
const MODERN_VERSION = "2025-09-03";

const SCHEMA_TTL_MS = 5 * 60 * 1000;

let sourceCache = null; // { mode, id, version, title, properties, titleProp, fetchedAt }

export class NotionError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = "NotionError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new NotionError(503, "not_configured", "NOTION_TOKEN is not configured");
  return t;
}

export function sourceIdFromEnv() {
  const id = process.env.NOTION_DATA_SOURCE_ID || process.env.NOTION_DATABASE_ID;
  if (!id) throw new NotionError(503, "not_configured", "NOTION_DATA_SOURCE_ID is not configured");
  return id.trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Notion REST 호출. 429/5xx는 지수 백오프로 최대 3회 재시도한다.
async function call(path, { method = "GET", body, version = LEGACY_VERSION, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Notion-Version": version,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (res.ok) return res.json();

    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = {}; }

    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000, 250 * 2 ** attempt);
      attempt += 1;
      await sleep(wait);
      continue;
    }

    throw new NotionError(
      res.status,
      payload.code || "notion_error",
      payload.message || `Notion responded ${res.status}`,
      payload.request_id
    );
  }
}

// 환경변수의 ID가 database인지 data source인지 판별하고 스키마를 캐시한다.
export async function getSource({ force = false } = {}) {
  const id = sourceIdFromEnv();
  const fresh = sourceCache
    && sourceCache.id === id
    && Date.now() - sourceCache.fetchedAt < SCHEMA_TTL_MS;
  if (fresh && !force) return sourceCache;

  let meta = null;
  let mode = null;

  try {
    meta = await call(`/databases/${id}`, { version: LEGACY_VERSION, retries: 1 });
    mode = "database";
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }

  if (!meta) {
    meta = await call(`/data_sources/${id}`, { version: MODERN_VERSION, retries: 1 });
    mode = "data_source";
  }

  const properties = meta.properties || {};
  const titleProp = Object.keys(properties).find(k => properties[k].type === "title") || null;

  sourceCache = {
    id,
    mode,
    version: mode === "database" ? LEGACY_VERSION : MODERN_VERSION,
    title: (meta.title || []).map(t => t.plain_text || "").join("") || null,
    properties,
    titleProp,
    fetchedAt: Date.now()
  };
  return sourceCache;
}

export async function queryPages({ filter, sorts, pageSize = 100, startCursor } = {}) {
  const src = await getSource();
  const body = { page_size: Math.min(100, Math.max(1, pageSize)) };
  if (filter) body.filter = filter;
  if (sorts && sorts.length) body.sorts = sorts;
  if (startCursor) body.start_cursor = startCursor;

  const path = src.mode === "database"
    ? `/databases/${src.id}/query`
    : `/data_sources/${src.id}/query`;

  return call(path, { method: "POST", body, version: src.version });
}

// filter 조건에 맞는 페이지를 maxScan까지 모은다. 잘렸으면 truncated로 알린다.
export async function queryAll({ filter, sorts, maxScan = 300 } = {}) {
  const results = [];
  let cursor;
  let truncated = false;

  do {
    const remaining = maxScan - results.length;
    if (remaining <= 0) { truncated = true; break; }
    const page = await queryPages({
      filter,
      sorts,
      pageSize: Math.min(100, remaining),
      startCursor: cursor
    });
    results.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
    if (cursor && results.length >= maxScan) { truncated = true; break; }
  } while (cursor);

  return { results, truncated, scanned: results.length };
}

export async function retrievePage(pageId) {
  const src = await getSource();
  return call(`/pages/${pageId}`, { version: src.version });
}

export async function createPage(properties, children) {
  const src = await getSource();
  const parent = src.mode === "database"
    ? { database_id: src.id }
    : { type: "data_source_id", data_source_id: src.id };
  const body = { parent, properties };
  if (children && children.length) body.children = children;
  return call(`/pages`, { method: "POST", body, version: src.version });
}

export async function updatePage(pageId, properties, extra = {}) {
  const src = await getSource();
  const body = { ...extra };
  if (properties && Object.keys(properties).length) body.properties = properties;
  return call(`/pages/${pageId}`, { method: "PATCH", body, version: src.version });
}

export async function appendBlocks(pageId, children) {
  const src = await getSource();
  return call(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: { children },
    version: src.version
  });
}

export async function listBlocks(pageId, pageSize = 50) {
  const src = await getSource();
  return call(`/blocks/${pageId}/children?page_size=${pageSize}`, { version: src.version });
}
