// 작업(task) <-> Notion 페이지 변환, 서버측 필터 생성, 유사도 계산
//
// DB 스키마를 런타임에 읽어 정규 필드명 -> 실제 Notion 속성명으로 매핑한다.
// 그래서 `📋 작업 관리`와 `작업·업무협업`처럼 속성 구성이 다른 DB에도 같은 코드가 붙는다.

import { getSource } from "./notion.js";

// 정규 필드명 -> 후보 Notion 속성명(앞쪽 우선)
const FIELD_ALIASES = {
  title:        ["작업명", "제목", "Name", "이름"],
  description:  ["작업내용", "내용", "설명"],
  status:       ["상태"],
  priority:     ["우선순위"],
  project:      ["프로젝트명"],
  assignee:     ["수행자"],
  requester:    ["의뢰자"],
  enteredBy:    ["입력자"],
  decision:     ["결정사항"],
  relatedFiles: ["관련파일"],
  note:         ["비고"],
  commit:       ["Git Commit"],
  workDate:     ["작업일"],
  completedAt:  ["완료일시"],
  duration:     ["작업시간"],
  collabType:   ["협업형태"],
  needsCheck:   ["확인필요"],
  owners:       ["담당자"],
  participants: ["참여자"],
  projectRef:   ["프로젝트"]
};

const DONE = "완료";

export async function fieldMap() {
  const src = await getSource();
  const props = src.properties;
  const map = {};
  for (const [field, candidates] of Object.entries(FIELD_ALIASES)) {
    const hit = candidates.find(name => Object.prototype.hasOwnProperty.call(props, name));
    if (hit) map[field] = hit;
  }
  if (!map.title && src.titleProp) map.title = src.titleProp;
  return { src, props, map };
}

/* ---------------------------------------------------------------- 값 읽기 */

export function decode(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "title":        return (prop.title || []).map(x => x.plain_text || "").join("");
    case "rich_text":    return (prop.rich_text || []).map(x => x.plain_text || "").join("");
    case "select":       return prop.select?.name ?? null;
    case "status":       return prop.status?.name ?? null;
    case "multi_select": return (prop.multi_select || []).map(o => o.name);
    case "checkbox":     return !!prop.checkbox;
    case "number":       return prop.number ?? null;
    case "url":          return prop.url ?? null;
    case "email":        return prop.email ?? null;
    case "phone_number": return prop.phone_number ?? null;
    case "date":
      if (!prop.date) return null;
      return prop.date.end ? { start: prop.date.start, end: prop.date.end } : prop.date.start;
    case "people":       return (prop.people || []).map(p => ({ id: p.id, name: p.name ?? null }));
    case "relation":     return (prop.relation || []).map(r => r.id);
    case "files":        return (prop.files || []).map(f => f.name);
    case "created_time":     return prop.created_time ?? null;
    case "last_edited_time": return prop.last_edited_time ?? null;
    case "unique_id":
      return prop.unique_id ? String(prop.unique_id.prefix ?? "") + prop.unique_id.number : null;
    case "formula": {
      const f = prop.formula || {};
      return f.string ?? f.number ?? f.boolean ?? f.date?.start ?? null;
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "array") return (r.array || []).map(decode);
      return r.number ?? r.date?.start ?? null;
    }
    default: return null;
  }
}

export function toTask(page, map) {
  const p = page.properties || {};
  const task = {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: !!page.archived
  };
  for (const [field, propName] of Object.entries(map)) {
    task[field] = decode(p[propName]);
  }
  // 매핑에 없는 속성은 raw로 보존한다 (AI가 스키마 차이를 흡수할 수 있게)
  const mapped = new Set(Object.values(map));
  const raw = {};
  for (const [name, prop] of Object.entries(p)) {
    if (!mapped.has(name)) raw[name] = decode(prop);
  }
  task.raw = raw;
  return task;
}

/* ---------------------------------------------------------------- 값 쓰기 */

const RICH_LIMIT = 2000;

function richText(value) {
  const s = String(value ?? "");
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += RICH_LIMIT) chunks.push(s.slice(i, i + RICH_LIMIT));
  return chunks.map(content => ({ type: "text", text: { content } }));
}

const READ_ONLY = new Set([
  "formula", "rollup", "created_time", "created_by",
  "last_edited_time", "last_edited_by", "unique_id"
]);

export function encode(schema, value) {
  if (!schema) throw new Error("이 DB에 없는 속성입니다");
  const t = schema.type;
  if (READ_ONLY.has(t)) throw new Error("'" + t + "' 속성은 읽기 전용이라 값을 쓸 수 없습니다");

  if (value === null || value === "") {
    switch (t) {
      case "select":       return { select: null };
      case "status":       return { status: null };
      case "date":         return { date: null };
      case "multi_select": return { multi_select: [] };
      case "relation":     return { relation: [] };
      case "people":       return { people: [] };
      case "number":       return { number: null };
      case "url":          return { url: null };
      case "email":        return { email: null };
      case "phone_number": return { phone_number: null };
      case "title":        return { title: [] };
      case "rich_text":    return { rich_text: [] };
      case "checkbox":     return { checkbox: false };
      default: throw new Error("'" + t + "' 속성은 지원하지 않습니다");
    }
  }

  switch (t) {
    case "title":     return { title: richText(value) };
    case "rich_text": return { rich_text: richText(value) };
    case "select":    return { select: { name: String(value) } };
    case "status":    return { status: { name: String(value) } };
    case "multi_select":
      return { multi_select: (Array.isArray(value) ? value : [value]).map(v => ({ name: String(v) })) };
    case "checkbox":     return { checkbox: !!value };
    case "number":       return { number: Number(value) };
    case "url":          return { url: String(value) };
    case "email":        return { email: String(value) };
    case "phone_number": return { phone_number: String(value) };
    case "date":
      if (value && typeof value === "object") {
        return { date: { start: value.start, end: value.end ?? null } };
      }
      return { date: { start: String(value) } };
    case "relation":
      return { relation: (Array.isArray(value) ? value : [value]).map(id => ({ id: String(id) })) };
    case "people":
      return { people: (Array.isArray(value) ? value : [value]).map(id => ({ object: "user", id: String(id) })) };
    default:
      throw new Error("'" + t + "' 속성은 지원하지 않습니다");
  }
}

// 정규 필드명과 실제 Notion 속성명을 둘 다 받아 Notion properties 페이로드로 만든다.
export function buildProperties(input, map, props) {
  const out = {};
  const errors = [];

  const put = (propName, value) => {
    try {
      out[propName] = encode(props[propName], value);
    } catch (e) {
      errors.push(propName + ": " + e.message);
    }
  };

  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    if (map[key]) { put(map[key], value); continue; }
    if (Object.prototype.hasOwnProperty.call(props, key)) { put(key, value); continue; }
    errors.push("'" + key + "'에 해당하는 속성이 이 DB에 없습니다");
  }

  return { properties: out, errors };
}

/* -------------------------------------------------------------- 서버측 필터 */

export function daysAgoISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// "7d" / "2026-08-20" / ISO datetime 을 ISO 문자열로
export function normalizeSince(value) {
  if (!value) return null;
  const m = /^(\d+)\s*d$/i.exec(String(value).trim());
  if (m) return daysAgoISO(Number(m[1]));
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const splitList = v => String(v).split(",").map(s => s.trim()).filter(Boolean);

// 상태 속성이 select인지 status인지에 따라 필터 키가 다르다.
function enumFilter(propName, schema, op, value) {
  const key = schema.type === "status" ? "status" : "select";
  return { property: propName, [key]: { [op]: value } };
}

function enumClause(propName, schema, raw) {
  const values = splitList(raw);
  if (values.length === 1) return enumFilter(propName, schema, "equals", values[0]);
  return { or: values.map(v => enumFilter(propName, schema, "equals", v)) };
}

/**
 * 조회 조건 -> Notion filter.
 * 전체를 받아와 클라이언트에서 거르지 않고 서버에서 걸러 오도록 하는 것이 목적이다.
 */
export function buildFilter(q, map, props) {
  const and = [];

  const statusProp = map.status;
  if (statusProp && props[statusProp]) {
    const s = props[statusProp];
    if (q.status) and.push(enumClause(statusProp, s, q.status));
    if (q.statusNot) {
      for (const v of splitList(q.statusNot)) {
        and.push(enumFilter(statusProp, s, "does_not_equal", v));
      }
    }
    // open=true 는 기본 중복검색 조건(상태 != 완료)의 축약형
    const open = q.open === true || q.open === "true" || q.open === "1";
    if (!q.status && !q.statusNot && open) {
      and.push(enumFilter(statusProp, s, "does_not_equal", DONE));
    }
  }

  if (q.q && map.title) {
    and.push({ property: map.title, title: { contains: String(q.q) } });
  }
  if (q.project && map.project && props[map.project]) {
    and.push({ property: map.project, rich_text: { contains: String(q.project) } });
  }
  if (q.assignee && map.assignee && props[map.assignee]) {
    and.push(enumClause(map.assignee, props[map.assignee], q.assignee));
  }
  if (q.priority && map.priority && props[map.priority]) {
    and.push(enumClause(map.priority, props[map.priority], q.priority));
  }

  const completedSince = normalizeSince(q.completedSince);
  if (completedSince && map.completedAt && props[map.completedAt]) {
    and.push({ property: map.completedAt, date: { on_or_after: completedSince } });
  }
  const workDateSince = normalizeSince(q.workDateSince);
  if (workDateSince && map.workDate && props[map.workDate]) {
    and.push({ property: map.workDate, date: { on_or_after: workDateSince } });
  }
  const workDateUntil = normalizeSince(q.workDateUntil);
  if (workDateUntil && map.workDate && props[map.workDate]) {
    and.push({ property: map.workDate, date: { on_or_before: workDateUntil } });
  }
  const updatedSince = normalizeSince(q.updatedSince);
  if (updatedSince) {
    and.push({ timestamp: "last_edited_time", last_edited_time: { on_or_after: updatedSince } });
  }

  if (!and.length) return undefined;
  return and.length === 1 ? and[0] : { and };
}

// "-완료일시,작업명" 형태를 Notion sorts로
export function buildSorts(sort, map, props) {
  if (!sort) return undefined;
  const sorts = [];
  for (const token of splitList(sort)) {
    const direction = token.startsWith("-") ? "descending" : "ascending";
    const rawName = token.replace(/^[-+]/, "");
    if (rawName === "last_edited_time" || rawName === "created_time") {
      sorts.push({ timestamp: rawName, direction });
      continue;
    }
    const propName = map[rawName] || (props[rawName] ? rawName : null);
    if (propName) sorts.push({ property: propName, direction });
  }
  return sorts.length ? sorts : undefined;
}

/* ------------------------------------------------------------------ 유사도 */

const PUNCT = /[[\]()<>{}"'`~!@#$%^&*_=+|\\/,.:;?\-–—·]/g;

export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(PUNCT, " ")
    .replace(/[（）〈〉！？ㆍ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s) {
  const t = s.replace(/\s/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (!set.size && t.length) set.add(t);
  return set;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function tokenOverlap(a, b) {
  const A = new Set(a.split(" ").filter(t => t.length > 1));
  const B = new Set(b.split(" ").filter(t => t.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size); // 포함관계에 관대한 containment
}

export function similarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const base = 0.6 * dice(x, y) + 0.4 * tokenOverlap(x, y);
  // 한쪽이 다른 쪽을 통째로 포함하면 사실상 같은 작업으로 본다
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) {
    return Math.max(base, 0.85);
  }
  return base;
}

/** 후보 작업들에 유사도 점수를 매겨 정렬한다. */
export function rankCandidates(tasks, { title, description, project }, threshold) {
  const scored = [];
  for (const t of tasks) {
    const titleScore = similarity(title, t.title);
    let score = titleScore;
    const reasons = [];
    if (titleScore > 0) reasons.push("제목 " + titleScore.toFixed(2));

    if (description && t.description) {
      const d = similarity(description, t.description);
      score = titleScore * 0.8 + d * 0.2;
      if (d > 0) reasons.push("내용 " + d.toFixed(2));
    }
    if (project && t.project && normalizeText(project) === normalizeText(t.project)) {
      score = Math.min(1, score + 0.05);
      reasons.push("같은 프로젝트");
    }
    if (score >= threshold) {
      scored.push({ ...t, score: Number(score.toFixed(3)), matchedOn: reasons.join(", ") });
    }
  }
  return scored.sort((a, b) => b.score - a.score);
}

export const DONE_STATUS = DONE;
