// 👥 직원·에이전트 (Notion 「👥 직원·에이전트」 DB)
//
// AI 공용 대화방의 발신자_직원/수신자_직원 Relation을 채우기 위해 이름 -> 직원
// page ID를 찾는 용도로만 쓴다. 이 DB 자체를 조회·수정하는 범용 모듈이 아니다.
//
// 2026-09-08 「AI 메신저 자동띵동 발신자·수신자 직원목록 동기화」 4단계-공통.
// 매 메시지마다 전체 직원명부를 다시 조회하면 Notion API 사용량이 불필요하게
// 늘어나므로, messengerSource()와 같은 패턴으로 이름->ID 인덱스를 캐시한다.
// 캐시에 없는 이름이 들어오면(신규 직원 반영 지연 가능성) 한 번만 강제 새로고침
// 하고, 그래도 없으면 진짜로 없는 것으로 본다 — 비슷한 이름으로 추측하지 않는다.

import { resolveSourceRef, retrieveSourceMeta, querySource } from "./notion.js";
import { decode } from "./tasks.js";
import { ApiError } from "./errors.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

let sourceCache = null; // { ref, nameProp, fetchedAt }
let indexCache = null;  // { byName: Map<string,string>, fetchedAt }

export async function employeeSource({ force = false } = {}) {
  if (sourceCache && !force && Date.now() - sourceCache.fetchedAt < CACHE_TTL_MS) {
    return sourceCache;
  }

  const id = (process.env.EMPLOYEE_DATA_SOURCE_ID || "").trim();
  if (!id) {
    throw new ApiError(503, "employee_directory_not_configured",
      "👥 직원·에이전트 데이터소스가 설정되지 않았습니다. " +
      "환경변수 EMPLOYEE_DATA_SOURCE_ID 에 직원명부 DB의 데이터소스 ID를 넣으세요.");
  }

  let ref;
  try {
    ref = await resolveSourceRef(id);
  } catch (e) {
    if (e.status === 404) {
      throw new ApiError(503, "employee_directory_unavailable",
        "👥 직원·에이전트 DB를 읽지 못했습니다(404). 노션에서 이 Integration이 연결돼 있는지 확인하세요.");
    }
    throw e;
  }

  const meta = await retrieveSourceMeta(ref);
  const props = meta.properties || {};
  const nameProp = Object.keys(props).find(k => props[k].type === "title") || "이름";

  sourceCache = { ref, nameProp, fetchedAt: Date.now() };
  return sourceCache;
}

/** "01.아빠" -> "아빠" 처럼 사람 레코드에 붙는 번호 접두사만 제거한다.
 *  이름 유사도로 추측하는 게 아니라, 이미 그 직원명부 안에서 쓰이는 고정된
 *  표기 규칙(번호.이름)을 되돌리는 것뿐이라 서로 다른 사람/AI를 섞을 위험이 없다. */
function stripNumberPrefix(name) {
  return name.replace(/^\d{1,3}\.\s*/, "");
}

/** "코덱스 (Codex)" 같은 "본명 (별칭)" 표기에서 괄호 앞/괄호 안 두 조각을 그
 *  레코드 자신의 별칭으로 추가 색인한다. 다른 레코드로 추측 연결하는 게 아니라,
 *  한 레코드의 제목 문자열 안에 이미 적혀 있는 이름을 그대로 꺼내는 것뿐이다.
 *  옛 발신자/수신자 select 값(예: "Codex")이 직원명부의 "코덱스 (Codex)"와
 *  정확히 문자열 일치하지 않아 생기는 호환 문제를 해결하기 위함
 *  (Claude Code/코덱스(Codex)는 사장님 지시로 이름을 바꾸지 않고 보존하기 때문). */
function parenthesisAliases(name) {
  const m = name.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (!m) return [];
  return [m[1].trim(), m[2].trim()].filter(Boolean);
}

async function buildIndex() {
  const { ref, nameProp } = await employeeSource();
  const page = await querySource(ref, { pageSize: 100 });
  const byName = new Map();
  for (const pg of page.results || []) {
    const raw = String(decode((pg.properties || {})[nameProp]) || "").trim();
    if (!raw) continue;
    if (!byName.has(raw)) byName.set(raw, pg.id);
    const stripped = stripNumberPrefix(raw);
    if (stripped !== raw && !byName.has(stripped)) byName.set(stripped, pg.id);
    for (const alias of parenthesisAliases(raw)) {
      if (!byName.has(alias)) byName.set(alias, pg.id);
    }
  }
  return { byName, fetchedAt: Date.now() };
}

async function employeeIndex({ force = false } = {}) {
  if (indexCache && !force && Date.now() - indexCache.fetchedAt < CACHE_TTL_MS) {
    return indexCache;
  }
  indexCache = await buildIndex();
  return indexCache;
}

/**
 * 이름 -> 직원 page ID. 못 찾으면 null(추측하지 않는다).
 * 캐시에 없으면 한 번만 강제로 최신화해서 다시 찾는다.
 */
export async function resolveEmployeeId(name) {
  const key = String(name || "").trim();
  if (!key) return null;

  let idx = await employeeIndex();
  if (idx.byName.has(key)) return idx.byName.get(key);

  idx = await employeeIndex({ force: true });
  return idx.byName.get(key) || null;
}
