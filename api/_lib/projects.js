// 프로젝트 원장 (Notion 「📁 프로젝트」 DB)
//
// 새 DB를 만들지 않는다. 이미 있는 📁 프로젝트 DB가 원장 정본이고,
// 이 모듈은 그것을 REST/MCP에서 읽고 쓸 수 있게 열어 줄 뿐이다.
//
// 어느 데이터소스가 프로젝트 원장인지는 환경변수로 따로 받지 않는다.
// 작업 DB의 `프로젝트` 관계 속성이 가리키는 곳을 그대로 따라간다.
// 설정이 두 벌로 갈라져 서로 어긋나는 일을 애초에 막으려는 것이다.

import {
  getSource, retrieveSourceMeta, querySource, sourceRefFromRelation,
  queryPages, retrievePage, updatePage, listBlocks
} from "./notion.js";
import { fieldMap, decode, encode, toTask, normalizeText, DONE_STATUS } from "./tasks.js";
import { ApiError } from "./errors.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

// 정규 필드명 -> 후보 Notion 속성명(앞쪽 우선)
const PROJECT_ALIASES = {
  name:         ["프로젝트명", "이름", "Name"],
  status:       ["상태"],
  summary:      ["한줄소개"],
  overview:     ["개요"],
  currentState: ["현재상태"],
  caution:      ["주의사항"],
  github:       ["GitHub"],
  todo:         ["TODO 링크"],
  priority:     ["우선순위"],
  visibility:   ["공개여부"],
  members:      ["참여자"]
};

let sourceCache = null; // { ref, props, map, title, fetchedAt }

/**
 * 프로젝트 원장 데이터소스를 알아낸다.
 * 작업 DB의 관계 속성 -> 그 관계가 가리키는 데이터소스.
 */
export async function projectSource({ force = false } = {}) {
  if (sourceCache && !force && Date.now() - sourceCache.fetchedAt < CACHE_TTL_MS) {
    return sourceCache;
  }

  const { props, map } = await fieldMap();
  const relName = map.projectRef;
  const rel = relName ? props[relName] : null;

  if (!rel || rel.type !== "relation") {
    throw new ApiError(503, "project_relation_unavailable",
      "작업 DB에서 프로젝트 관계 속성을 찾지 못했습니다. " +
      "노션에서 「📁 프로젝트」 DB에 이 Integration이 연결돼 있는지 확인하세요. " +
      "연결돼 있지 않으면 노션이 관계 속성 자체를 응답에서 빼버립니다.");
  }

  const ref = sourceRefFromRelation(rel.relation);
  if (!ref) {
    throw new ApiError(503, "project_relation_unavailable",
      "프로젝트 관계 속성에 대상 데이터소스 정보가 없습니다.");
  }

  const meta = await retrieveSourceMeta(ref);
  const props2 = meta.properties || {};
  const map2 = {};
  for (const [field, candidates] of Object.entries(PROJECT_ALIASES)) {
    const hit = candidates.find(n => Object.prototype.hasOwnProperty.call(props2, n));
    if (hit) map2[field] = hit;
  }
  if (!map2.name) {
    map2.name = Object.keys(props2).find(k => props2[k].type === "title") || null;
  }

  sourceCache = {
    ref,
    props: props2,
    map: map2,
    title: (meta.title || []).map(t => t.plain_text || "").join("") || null,
    taskRelationProp: relName,
    fetchedAt: Date.now()
  };
  return sourceCache;
}

function toProject(page, map) {
  const p = page.properties || {};
  const out = {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time
  };
  for (const [field, propName] of Object.entries(map)) {
    if (propName) out[field] = decode(p[propName]);
  }
  return out;
}

/* ---------------------------------------------------------------- 조회 */

/** 프로젝트 목록. 조건은 전부 노션 서버에서 걸린다. */
export async function listProjects(q = {}) {
  const { ref, props, map } = await projectSource();
  const and = [];

  if (q.status) {
    const propName = map.status;
    if (!propName) {
      throw new ApiError(400, "filter_not_supported", "이 프로젝트 DB에는 상태 속성이 없습니다");
    }
    const key = props[propName].type === "status" ? "status" : "select";
    const values = String(q.status).split(",").map(s => s.trim()).filter(Boolean);
    and.push(values.length === 1
      ? { property: propName, [key]: { equals: values[0] } }
      : { or: values.map(v => ({ property: propName, [key]: { equals: v } })) });
  }
  if (q.q && map.name) {
    and.push({ property: map.name, title: { contains: String(q.q) } });
  }

  const filter = !and.length ? undefined : (and.length === 1 ? and[0] : { and });
  const page = await querySource(ref, {
    filter,
    pageSize: Math.min(100, Math.max(1, Number(q.limit) || 50)),
    startCursor: q.cursor || undefined
  });

  return {
    ok: true,
    count: (page.results || []).length,
    has_more: !!page.has_more,
    next_cursor: page.next_cursor || null,
    projects: (page.results || []).map(pg => toProject(pg, map))
  };
}

/** 이름으로 프로젝트 페이지를 찾는다. 정확히 같은 이름 우선, 없으면 포함 관계. */
export async function findProjectByName(name) {
  const wanted = normalizeText(name);
  if (!wanted) return null;

  const { projects } = await listProjects({ limit: 100 });
  return (
    projects.find(p => normalizeText(p.name) === wanted) ||
    projects.find(p => {
      const n = normalizeText(p.name);
      return n && (n.includes(wanted) || wanted.includes(n));
    }) ||
    null
  );
}

/** 새 작업의 프로젝트 관계 자동 연결용. 못 찾거나 원장을 못 읽으면 조용히 null. */
export async function resolveProjectIdByName(name) {
  try {
    const hit = await findProjectByName(name);
    return hit ? hit.id : null;
  } catch {
    return null; // 프로젝트 원장을 못 읽는다고 해서 작업 생성 자체를 막지는 않는다
  }
}

async function resolveProject(idOrName) {
  const { map } = await projectSource();
  const value = String(idOrName || "").trim();
  if (!value) throw new ApiError(400, "invalid_request", "프로젝트 이름이나 ID가 필요합니다");

  const isUuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
  if (isUuid) return toProject(await retrievePage(value), map);

  const hit = await findProjectByName(value);
  if (!hit) {
    throw new ApiError(404, "project_not_found",
      "「" + value + "」 프로젝트를 원장에서 찾지 못했습니다. list_projects 로 이름을 확인하세요.");
  }
  return hit;
}

/**
 * 프로젝트 한 건 + 그 프로젝트의 작업.
 *
 * 작업은 「📁 프로젝트」의 옛 관계(연결 작업)가 아니라 현행 작업 DB를 직접 조회한다.
 * 프로젝트 관계로 연결된 작업과, 관계가 아직 안 채워졌지만 프로젝트명 텍스트가
 * 일치하는 작업을 함께 잡는다(마이그레이션 전후가 섞여 있어서).
 */
export async function getProject(idOrName, opts = {}) {
  const { map } = await projectSource();
  const project = await resolveProject(idOrName);

  const openLimit = Math.min(100, Math.max(1, Number(opts.openLimit) || 30));
  const doneLimit = Math.min(100, Math.max(1, Number(opts.doneLimit) || 10));
  const doneWithinDays = Number(opts.doneWithinDays) || 30;

  const { map: tmap, props: tprops } = await fieldMap();
  const relProp = tmap.projectRef;
  const statusProp = tmap.status;
  const nameProp = tmap.project;
  const doneProp = tmap.completedAt;
  const statusKey = statusProp && tprops[statusProp].type === "status" ? "status" : "select";

  const belongs = [{ property: relProp, relation: { contains: project.id } }];
  if (nameProp && project.name) {
    belongs.push({ property: nameProp, rich_text: { contains: project.name } });
  }
  const belongsTo = belongs.length === 1 ? belongs[0] : { or: belongs };

  const withStatus = extra => (extra ? { and: [belongsTo, ...extra] } : belongsTo);

  const openPage = await queryPages({
    filter: withStatus(statusProp ? [{ property: statusProp, [statusKey]: { does_not_equal: DONE_STATUS } }] : null),
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    pageSize: openLimit
  });

  const doneClauses = [];
  if (statusProp) doneClauses.push({ property: statusProp, [statusKey]: { equals: DONE_STATUS } });
  if (doneProp) {
    doneClauses.push({
      property: doneProp,
      date: { on_or_after: new Date(Date.now() - doneWithinDays * 86400000).toISOString() }
    });
  }
  const donePage = doneClauses.length
    ? await queryPages({
        filter: withStatus(doneClauses),
        sorts: doneProp ? [{ property: doneProp, direction: "descending" }] : undefined,
        pageSize: doneLimit
      })
    : { results: [] };

  // 노션 검색 인덱스가 페이지 실제 값과 어긋나는 경우가 있다.
  // 실측(2026-09-03): 상태를 완료로 바꾼 지 사흘 지난 페이지가 인덱스에는 아직
  // `대기`로 남아 있어, 미완료 조건에 걸려 나왔다. 페이지 본문의 값이 정본이므로
  // 미완료 목록에서는 빼되, 조용히 감추지 않고 indexMismatch 로 함께 알린다.
  const openRaw = (openPage.results || []).map(p => toTask(p, tmap));
  const openTasks = openRaw.filter(t => t.status !== DONE_STATUS);
  const indexMismatch = openRaw
    .filter(t => t.status === DONE_STATUS)
    .map(t => ({ id: t.id, title: t.title, status: t.status, last_edited_time: t.last_edited_time }));

  const result = {
    ok: true,
    project,
    openTasks,
    openTasksTruncated: !!openPage.has_more,
    recentlyDone: (donePage.results || []).map(p => toTask(p, tmap)),
    recentlyDoneWithinDays: doneWithinDays,
    recentlyDoneTruncated: !!donePage.has_more
  };

  if (indexMismatch.length) {
    result.indexMismatch = indexMismatch;
    result.indexMismatchNote =
      "노션 검색 인덱스가 페이지 실제 값과 다릅니다. 아래 작업들은 인덱스에서는 미완료로 잡히지만 " +
      "페이지에는 완료로 저장돼 있어 미완료 목록에서 제외했습니다. " +
      "노션에서 해당 작업의 상태를 한 번 다시 저장하면 인덱스가 맞춰집니다.";
  }

  if (opts.blocks) {
    const children = await listBlocks(project.id);
    result.project.content = (children.results || [])
      .map(b => {
        const body = b[b.type];
        const rt = body && body.rich_text;
        return Array.isArray(rt) ? rt.map(x => x.plain_text || "").join("") : "";
      })
      .filter(Boolean);
  }

  return result;
}

/* ---------------------------------------------------------------- 수정 */

/**
 * 프로젝트 원장 갱신. 주로 `현재상태` 를 최신으로 바꾸는 데 쓴다.
 * 작업을 마감할 때 프로젝트 현재상태도 같이 갱신하라고 만든 자리다.
 */
export async function updateProject(idOrName, body = {}) {
  const { props, map } = await projectSource();
  const project = await resolveProject(idOrName);

  const { stampDate, ...fields } = body;
  const properties = {};
  const errors = [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) continue;
    const propName = map[key] || (Object.prototype.hasOwnProperty.call(props, key) ? key : null);
    if (!propName) {
      errors.push("'" + key + "'에 해당하는 속성이 프로젝트 DB에 없습니다");
      continue;
    }
    let value = rawValue;
    if (key === "currentState" && stampDate && value) {
      value = String(value) + " (" + new Date().toISOString().slice(0, 10) + ")";
    }
    try {
      properties[propName] = encode(props[propName], value);
    } catch (e) {
      errors.push(propName + ": " + e.message);
    }
  }

  if (errors.length) throw new ApiError(400, "invalid_properties", errors.join(" / "));
  if (!Object.keys(properties).length) {
    throw new ApiError(400, "invalid_request", "바꿀 내용이 없습니다");
  }

  const page = await updatePage(project.id, properties);
  return { ok: true, updated: true, project: toProject(page, map) };
}

/** 프로젝트 원장 스키마 (어떤 값을 넣을 수 있는지 확인용) */
export async function getProjectSchema() {
  const { ref, props, map, title, taskRelationProp } = await projectSource();
  const properties = {};
  for (const [name, p] of Object.entries(props)) {
    const entry = { type: p.type };
    if (p.type === "select") entry.options = p.select.options.map(o => o.name);
    if (p.type === "status") entry.options = p.status.options.map(o => o.name);
    if (p.type === "multi_select") entry.options = p.multi_select.options.map(o => o.name);
    if (p.type === "relation") entry.relation = true;
    properties[name] = entry;
  }
  const src = await getSource();
  return {
    ok: true,
    source: { id: ref.id, mode: ref.mode, title },
    discoveredFrom: { taskSourceId: src.id, relationProperty: taskRelationProp },
    fieldMap: map,
    properties
  };
}
