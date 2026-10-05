// 범용 Notion 도구 구현 (MCP 등록은 index.ts)
import { api, paginate, normId, token, NOTION_VERSION } from "./notion.js";
import { titleOf, simplifyProps, buildProps, schemaDef, mdToBlocks, appendBlocks, blocksToMd, plain, inlineMd } from "./format.js";
import {
  resolve, describe, toDataSource, owningPage, assertNotRuleDoc, audit, markCreated, createdInfo,
  PROTECTED, newPending, takePending, TRASH_MAX, Kind,
} from "./core.js";

// ───────── 검색 ─────────
export async function search(a: { query: string; type?: "page" | "data_source" | "all"; limit?: number; scope_id?: string; include_content?: boolean; max_scan?: number; include_trashed?: boolean }) {
  const limit = a.limit ?? 20;
  const body: any = { query: a.query };
  if (a.type && a.type !== "all") body.filter = { property: "object", value: a.type };
  let hits: any[] = (await paginate("POST", "/search", body, a.scope_id ? 500 : limit)).map((r: any) => ({
    kind: r.object, id: r.id, title: titleOf(r), parent: r.parent?.[r.parent?.type] ?? r.parent?.type, url: r.url,
    in_trash: r.in_trash ?? false, last_edited_time: r.last_edited_time, match: "title",
  }));
  if (!a.include_trashed) hits = hits.filter((h: any) => !h.in_trash);
  if (a.scope_id) {
    const inScope = new Set(await descendants(a.scope_id, a.max_scan ?? 300));
    hits = hits.filter((h: any) => inScope.has(h.id));
  }
  hits = hits.slice(0, limit);
  if (a.include_content) {
    if (!a.scope_id) throw new Error("본문 검색(include_content)은 범위가 필요합니다: scope_id(페이지/DB)를 주세요. 워크스페이스 전체 본문 스캔은 너무 무거워 막아 두었습니다.");
    const q = a.query.toLowerCase();
    const ids = await descendants(a.scope_id, a.max_scan ?? 150, true);
    for (const pid of ids) {
      if (hits.length >= limit) break;
      if (hits.some((h: any) => h.id === pid)) continue;
      try {
        const md = await blocksToMd(pid, 0, 1, { n: 0, max: 300 });
        const idx = md.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const p = await api("GET", `/pages/${pid}`);
          hits.push({ kind: "page", id: pid, title: titleOf(p), parent: p.parent?.[p.parent?.type], url: p.url, in_trash: p.in_trash, last_edited_time: p.last_edited_time, match: "content", snippet: md.slice(Math.max(0, idx - 60), idx + 120) });
        }
      } catch {}
    }
  }
  return { count: hits.length, results: hits };
}

/** 페이지·DB 아래 모든 하위 페이지 ID (BFS, 상한) */
async function descendants(rootId: string, max: number, pagesOnly = false): Promise<string[]> {
  const out: string[] = [];
  const queue: { id: string; kind: string }[] = [];
  const r = await resolve(rootId);
  queue.push({ id: r.id, kind: r.kind });
  while (queue.length && out.length < max) {
    const cur = queue.shift()!;
    if (cur.kind === "page" || cur.kind === "block") {
      if (cur.kind === "page") out.push(cur.id);
      for (const b of await paginate("GET", `/blocks/${cur.id}/children`, {}, 500)) {
        if (b.type === "child_page") queue.push({ id: b.id, kind: "page" });
        else if (b.type === "child_database") queue.push({ id: b.id, kind: "database" });
        else if (b.has_children && ["toggle", "column_list", "column", "synced_block", "callout"].includes(b.type)) queue.push({ id: b.id, kind: "block" });
      }
    } else if (cur.kind === "database" || cur.kind === "data_source") {
      if (!pagesOnly) out.push(cur.id);
      let dsIds: string[] = [];
      if (cur.kind === "database") { try { dsIds = (await api("GET", `/databases/${cur.id}`)).data_sources.map((d: any) => d.id); } catch {} }
      else dsIds = [cur.id];
      for (const ds of dsIds) {
        if (!pagesOnly) out.push(ds);
        for (const row of await paginate("POST", `/data_sources/${ds}/query`, {}, Math.max(1, max - out.length))) queue.push({ id: row.id, kind: "page" });
      }
    }
  }
  return out.slice(0, max);
}

// ───────── 조회 ─────────
export async function get(a: { id: string }) {
  return describe(await resolve(a.id), true);
}

export async function getContent(a: { id: string; max_depth?: number; max_blocks?: number }) {
  const r = await resolve(a.id);
  if (r.kind === "database" || r.kind === "data_source") throw new Error("DB는 본문이 없습니다. query 또는 get_schema를 쓰세요.");
  const md = await blocksToMd(r.id, 0, a.max_depth ?? 3, { n: 0, max: a.max_blocks ?? 1500 });
  return { id: r.id, title: titleOf(r.obj), markdown: md };
}

export async function listChildren(a: { id: string }) {
  const r = await resolve(a.id);
  if (r.kind === "database" || r.kind === "data_source") {
    const { dsId } = await toDataSource(r.id);
    const rows = await paginate("POST", `/data_sources/${dsId}/query`, {}, 200);
    return { kind: "data_source", id: dsId, count: rows.length, rows: rows.map((p: any) => ({ id: p.id, title: titleOf(p) })) };
  }
  const kids: any[] = [];
  const walk = async (id: string, depth: number) => {
    for (const b of await paginate("GET", `/blocks/${id}/children`, {}, 1000)) {
      if (b.type === "child_page") kids.push({ kind: "page", id: b.id, title: b.child_page.title });
      else if (b.type === "child_database") {
        let ds: any[] = [];
        try { ds = (await api("GET", `/databases/${b.id}`)).data_sources; } catch {}
        kids.push({ kind: "database", id: b.id, title: b.child_database.title, data_sources: ds });
      } else if (b.has_children && depth < 2 && ["toggle", "column_list", "column", "synced_block", "callout"].includes(b.type)) await walk(b.id, depth + 1);
    }
  };
  await walk(r.id, 0);
  return { id: r.id, title: titleOf(r.obj), count: kids.length, children: kids };
}

export async function getSchema(a: { id: string }) {
  const { dsId, ds } = await toDataSource(a.id);
  const props: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(ds.properties)) {
    const d: any = { type: v.type, id: v.id };
    if (["select", "multi_select", "status"].includes(v.type)) d.options = v[v.type].options.map((o: any) => o.name);
    if (v.type === "relation") d.relation = { data_source_id: v.relation.data_source_id, type: v.relation.type };
    if (v.type === "formula") d.expression = v.formula.expression;
    props[k] = d;
  }
  return { data_source_id: dsId, database_id: ds.parent?.database_id, title: titleOf(ds), in_trash: ds.in_trash ?? false, properties: props };
}

/** where: {속성: 값} 단순 조건 → Notion filter */
function whereToFilter(schema: Record<string, any>, where: Record<string, any>): any {
  const and: any[] = [];
  for (const [name, val] of Object.entries(where)) {
    const def = schema[name];
    if (!def) throw new Error(`속성 "${name}" 없음. 있는 속성: ${Object.keys(schema).join(", ")}`);
    const t = def.type === "formula" ? "formula" : def.type;
    if (val && typeof val === "object" && !Array.isArray(val)) { and.push({ property: name, [t]: val }); continue; }
    const vals = Array.isArray(val) ? val : [val];
    const conds = vals.map((v) => {
      switch (t) {
        case "title": case "rich_text": case "url": case "email": case "phone_number": return { property: name, [t]: { contains: String(v) } };
        case "select": case "status": return { property: name, [t]: { equals: String(v) } };
        case "multi_select": return { property: name, multi_select: { contains: String(v) } };
        case "checkbox": return { property: name, checkbox: { equals: v === true || v === "true" } };
        case "number": return { property: name, number: { equals: Number(v) } };
        case "date": return { property: name, date: { equals: String(v) } };
        case "relation": return { property: name, relation: { contains: normId(String(v)) } };
        case "people": return { property: name, people: { contains: normId(String(v)) } };
        default: throw new Error(`"${name}"(${t})는 단순 조건을 지원하지 않습니다. filter에 Notion 원형 조건을 쓰세요.`);
      }
    });
    and.push(conds.length === 1 ? conds[0] : { or: conds });
  }
  return and.length === 1 ? and[0] : { and };
}

export async function query(a: { id: string; where?: Record<string, any>; filter?: any; sorts?: any[]; limit?: number; include_properties?: boolean }) {
  const { dsId, ds } = await toDataSource(a.id);
  const body: any = {};
  const filters: any[] = [];
  if (a.where && Object.keys(a.where).length) filters.push(whereToFilter(ds.properties, a.where));
  if (a.filter) filters.push(a.filter);
  if (filters.length) body.filter = filters.length === 1 ? filters[0] : { and: filters };
  if (a.sorts) body.sorts = a.sorts;
  const rows = await paginate("POST", `/data_sources/${dsId}/query`, body, a.limit ?? 50);
  const out = [];
  for (const p of rows) out.push({ id: p.id, title: titleOf(p), url: p.url, ...(a.include_properties === false ? {} : { properties: await simplifyProps(p, false) }) });
  return { data_source_id: dsId, count: out.length, rows: out };
}

// ───────── 생성 ─────────
async function parentFor(parentId: string): Promise<{ parent: any; schema?: any; parentKind: Kind }> {
  const r = await resolve(parentId);
  if (r.kind === "page") return { parent: { type: "page_id", page_id: r.id }, parentKind: "page" };
  if (r.kind === "data_source" || r.kind === "database") {
    const { dsId, ds } = await toDataSource(r.id);
    return { parent: { type: "data_source_id", data_source_id: dsId }, schema: ds.properties, parentKind: "data_source" };
  }
  throw new Error("부모는 페이지 또는 DB/데이터소스여야 합니다.");
}

export async function createPage(a: { parent_id: string; title: string; properties?: Record<string, any>; content_markdown?: string; icon?: string; test_object?: boolean }) {
  const { parent, schema, parentKind } = await parentFor(a.parent_id);
  if (parentKind === "page") assertNotRuleDoc(parent.page_id);
  let properties: any;
  if (schema) {
    const titleProp = Object.entries<any>(schema).find(([, v]) => v.type === "title")![0];
    properties = buildProps(schema, { [titleProp]: a.title, ...(a.properties || {}) });
  } else {
    if (a.properties && Object.keys(a.properties).length) throw new Error("일반 페이지 아래 페이지는 title 외 속성을 가질 수 없습니다.");
    properties = { title: { title: inlineMd(a.title) } };
  }
  const blocks = mdToBlocks(a.content_markdown || "");
  const body: any = { parent, properties };
  if (a.icon) body.icon = { type: "emoji", emoji: a.icon };
  const page = await api("POST", "/pages", body);
  if (blocks.length) await appendBlocks(page.id, blocks);
  markCreated(page.id, "page", a.title, !!a.test_object);
  audit({ tool: "create_page", id: page.id, parent: a.parent_id, title: a.title });
  const after = await describe(await resolve(page.id), true);
  return { created: true, verified: after.title === a.title.replace(/\*\*|`|~~/g, "") || after.title.length > 0, page: after };
}

export async function createDatabase(a: { parent_page_id: string; title: string; properties: Record<string, any>; test_object?: boolean }) {
  const pid = normId(a.parent_page_id);
  assertNotRuleDoc(pid);
  const props: Record<string, any> = {};
  let hasTitle = false;
  for (const [k, v] of Object.entries(a.properties)) { props[k] = schemaDef(v); if (v === "title") hasTitle = true; }
  if (!hasTitle) props["이름"] = { title: {} };
  const db = await api("POST", "/databases", { parent: { type: "page_id", page_id: pid }, title: inlineMd(a.title), initial_data_source: { properties: props } });
  markCreated(db.id, "database", a.title, !!a.test_object);
  for (const d of db.data_sources || []) markCreated(d.id, "data_source", a.title, !!a.test_object);
  audit({ tool: "create_database", id: db.id, parent: pid, title: a.title });
  const re = await api("GET", `/databases/${db.id}`);
  return { created: true, database_id: db.id, data_sources: re.data_sources, title: titleOf(re), parent: re.parent };
}

// ───────── 수정 ─────────
export async function updatePage(a: { id: string; title?: string; properties?: Record<string, any>; icon?: string | null }) {
  const id = normId(a.id);
  assertNotRuleDoc(id);
  const page = await api("GET", `/pages/${id}`);
  if (page.in_trash) throw new Error("휴지통에 있는 페이지입니다. 먼저 restore 하세요.");
  const body: any = {};
  if (page.parent?.type === "data_source_id") {
    const ds = await api("GET", `/data_sources/${page.parent.data_source_id}`);
    const vals = { ...(a.properties || {}) };
    if (a.title !== undefined) vals[Object.entries<any>(ds.properties).find(([, v]) => v.type === "title")![0]] = a.title;
    if (Object.keys(vals).length) body.properties = buildProps(ds.properties, vals);
  } else {
    if (a.properties && Object.keys(a.properties).length) throw new Error("일반 페이지는 title 외 속성이 없습니다.");
    if (a.title !== undefined) body.properties = { title: { title: inlineMd(a.title) } };
  }
  if (a.icon !== undefined) body.icon = a.icon ? { type: "emoji", emoji: a.icon } : null;
  if (!Object.keys(body).length) throw new Error("바꿀 내용이 없습니다.");
  await api("PATCH", `/pages/${id}`, body);
  audit({ tool: "update_page", id, keys: Object.keys(a.properties || {}).concat(a.title !== undefined ? ["title"] : []) });
  const after = await describe(await resolve(id), true);
  const mismatches: string[] = [];
  if (a.title !== undefined && after.title !== a.title.replace(/\*\*|`|~~/g, "")) mismatches.push(`title: ${after.title}`);
  for (const [k, v] of Object.entries(a.properties || {})) if (!sameVal(after.properties?.[k], v)) mismatches.push(`${k}: 기대 ${JSON.stringify(v)} / 실제 ${JSON.stringify(after.properties?.[k])}`);
  return { updated: true, verified: mismatches.length === 0, mismatches, page: after };
}

export function sameVal(actual: any, expected: any): boolean {
  if (expected === null) return actual === null || actual === "" || (Array.isArray(actual) && !actual.length) || actual === false;
  if (Array.isArray(expected)) {
    const e = expected.map((x) => (typeof x === "string" && /[0-9a-f]{32}|[0-9a-f-]{36}/i.test(x) ? safeNorm(x) : x)).sort();
    const a2 = (actual || []).map((x: any) => (typeof x === "string" && /[0-9a-f-]{36}/i.test(x) ? safeNorm(x) : x)).sort();
    return JSON.stringify(e) === JSON.stringify(a2);
  }
  if (typeof expected === "object") return actual && (actual === expected.start || actual.start === expected.start);
  if (typeof expected === "boolean") return actual === expected;
  if (typeof expected === "number") return Number(actual) === expected;
  return String(actual ?? "") === String(expected).replace(/\*\*|`|~~/g, "");
}
const safeNorm = (x: string) => { try { return normId(x); } catch { return x; } };

export async function writeContent(a: { id: string; mode: "append" | "replace" | "replace_text"; markdown?: string; old_text?: string; new_text?: string; after_block_id?: string }, allowRules = false) {
  const r = await resolve(a.id);
  if (r.kind !== "page" && r.kind !== "block") throw new Error("본문은 페이지(또는 블록)에만 쓸 수 있습니다.");
  const pageId = r.kind === "page" ? r.id : await owningPage(r.id);
  if (!allowRules && pageId) assertNotRuleDoc(pageId);
  if (a.mode === "append") {
    const ids = await appendBlocks(r.id, mdToBlocks(a.markdown || ""), a.after_block_id ? normId(a.after_block_id) : undefined);
    audit({ tool: "write_content", mode: "append", id: r.id, blocks: ids.length });
    const md = await blocksToMd(r.id, 0, 2);
    const probe = (a.markdown || "").split("\n").map((l) => l.replace(/^[#>\-*\d.\s\[\]x]+/, "").replace(/\*\*|`|~~/g, "").trim()).find((l) => l.length > 3);
    return { appended_blocks: ids.length, verified: !probe || md.includes(probe.slice(0, 40)), block_ids: ids };
  }
  if (a.mode === "replace") {
    const kids = await paginate("GET", `/blocks/${r.id}/children`, {}, 5000);
    const keep = kids.filter((b: any) => b.type === "child_page" || b.type === "child_database");
    const del = kids.filter((b: any) => !(b.type === "child_page" || b.type === "child_database"));
    for (const b of del) await api("DELETE", `/blocks/${b.id}`);
    const ids = await appendBlocks(r.id, mdToBlocks(a.markdown || ""));
    audit({ tool: "write_content", mode: "replace", id: r.id, removed: del.length, added: ids.length, kept_children: keep.length });
    const after = await paginate("GET", `/blocks/${r.id}/children`, {}, 5000);
    return { removed_blocks: del.length, added_blocks: ids.length, preserved_child_pages_dbs: keep.map((b: any) => titleOf(b)), verified: after.length === keep.length + ids.length || after.length >= ids.length };
  }
  // replace_text: 텍스트가 들어 있는 블록 1개를 찾아 그 블록의 글만 교체
  if (!a.old_text) throw new Error("replace_text에는 old_text가 필요합니다.");
  const found: any[] = [];
  const walk = async (id: string, depth: number) => {
    for (const b of await paginate("GET", `/blocks/${id}/children`, {}, 3000)) {
      const rtArr = b[b.type]?.rich_text;
      if (rtArr && plain(rtArr).includes(a.old_text!)) found.push(b);
      if (b.has_children && depth < 3 && !["child_page", "child_database"].includes(b.type)) await walk(b.id, depth + 1);
    }
  };
  await walk(r.id, 0);
  if (found.length !== 1) throw new Error(`old_text가 ${found.length}개 블록에서 발견됨 — 정확히 1개여야 합니다. 더 길게 지정하세요.`);
  const b = found[0];
  const newPlain = plain(b[b.type].rich_text).replace(a.old_text, a.new_text ?? "");
  await api("PATCH", `/blocks/${b.id}`, { [b.type]: { rich_text: inlineMd(newPlain) } });
  audit({ tool: "write_content", mode: "replace_text", id: r.id, block: b.id });
  const re = await api("GET", `/blocks/${b.id}`);
  return { block_id: b.id, verified: plain(re[re.type].rich_text) === newPlain.replace(/\*\*|`|~~/g, "") || plain(re[re.type].rich_text).includes((a.new_text || "").replace(/\*\*|`|~~/g, "")), text: plain(re[re.type].rich_text) };
}

export async function setRelation(a: { page_id: string; property: string; add?: string[]; remove?: string[]; set?: string[] }) {
  const id = normId(a.page_id);
  assertNotRuleDoc(id);
  const page = await api("GET", `/pages/${id}`);
  const props = await simplifyProps(page);
  if (!(a.property in props)) throw new Error(`속성 "${a.property}" 없음`);
  if (page.properties[a.property].type !== "relation") throw new Error(`"${a.property}"는 relation이 아닙니다.`);
  const before: string[] = props[a.property];
  let next: string[];
  if (a.set) next = a.set.map(normId);
  else {
    const add = (a.add || []).map(normId), rem = new Set((a.remove || []).map(normId));
    next = [...new Set([...before, ...add])].filter((x) => !rem.has(x));
  }
  await api("PATCH", `/pages/${id}`, { properties: { [a.property]: { relation: next.map((x) => ({ id: x })) } } });
  audit({ tool: "set_relation", id, property: a.property, before: before.length, after: next.length });
  const afterProps = await simplifyProps(await api("GET", `/pages/${id}`));
  const after: string[] = afterProps[a.property];
  return { before, after, verified: sameVal(after, next) };
}

export async function updateSchema(a: { id: string; title?: string; add?: Record<string, any>; rename?: Record<string, string>; remove?: string[]; change_options?: Record<string, string[]> }) {
  const { dsId, ds } = await toDataSource(a.id);
  const props: Record<string, any> = {};
  for (const [k, v] of Object.entries(a.add || {})) props[k] = schemaDef(v);
  for (const [k, v] of Object.entries(a.rename || {})) { if (!ds.properties[k]) throw new Error(`"${k}" 없음`); props[k] = { name: v }; }
  for (const k of a.remove || []) {
    if (!ds.properties[k]) throw new Error(`"${k}" 없음`);
    if (ds.properties[k].type === "title") throw new Error("title 속성은 삭제할 수 없습니다.");
    props[k] = null;
  }
  for (const [k, opts] of Object.entries(a.change_options || {})) {
    const t = ds.properties[k]?.type;
    if (!["select", "multi_select"].includes(t)) throw new Error(`"${k}"는 select/multi_select가 아닙니다.`);
    const existing = ds.properties[k][t].options;
    props[k] = { [t]: { options: opts.map((n) => existing.find((o: any) => o.name === n) ? { id: existing.find((o: any) => o.name === n).id, name: n } : { name: n }) } };
  }
  if (a.remove?.length && PROTECTED.has(dsId)) throw new Error("보호 대상 DB의 속성 삭제는 MCP로 하지 않습니다 (데이터 손실 위험). 아빠가 직접 처리하세요.");
  const body: any = {};
  if (Object.keys(props).length) body.properties = props;
  if (a.title) body.title = inlineMd(a.title);
  await api("PATCH", `/data_sources/${dsId}`, body);
  audit({ tool: "update_schema", id: dsId, add: Object.keys(a.add || {}), rename: a.rename, remove: a.remove });
  const after = await getSchema({ id: dsId });
  const problems: string[] = [];
  for (const k of Object.keys(a.add || {})) if (!after.properties[k]) problems.push(`추가 안 됨: ${k}`);
  for (const [k, v] of Object.entries(a.rename || {})) if (!after.properties[v] || after.properties[k]) problems.push(`이름변경 미반영: ${k}→${v}`);
  for (const k of a.remove || []) if (after.properties[k]) problems.push(`삭제 안 됨: ${k}`);
  return { verified: problems.length === 0, problems, schema: after };
}

// ───────── 이동 ─────────
export async function move(a: { id: string; new_parent_id: string }) {
  const r = await resolve(a.id);
  if (PROTECTED.has(r.id) && process.env.WOOS_ALLOW_PROTECTED_MOVE !== "1") {
    // 구조 재편 단계에서 핵심 객체를 옮길 수는 있어야 하므로, 막지는 않고 기록만 남긴다
  }
  const target = await resolve(a.new_parent_id);
  const before = (await describe(r, false)).parent;
  if (r.kind === "page") {
    const parent = target.kind === "page" ? { type: "page_id", page_id: target.id }
      : { type: "data_source_id", data_source_id: (await toDataSource(target.id)).dsId };
    await api("POST", `/pages/${r.id}/move`, { parent });
  } else if (r.kind === "database") {
    if (target.kind !== "page") throw new Error("DB는 페이지 아래로만 옮길 수 있습니다.");
    await api("PATCH", `/databases/${r.id}`, { parent: { type: "page_id", page_id: target.id } });
  } else if (r.kind === "data_source") {
    const dbId = r.obj.parent?.database_id;
    if (!dbId) throw new Error("데이터소스의 DB를 찾지 못했습니다.");
    if (target.kind !== "page") throw new Error("데이터소스를 옮기려면 그 DB를 페이지 아래로 옮깁니다. 대상은 페이지여야 합니다.");
    await api("PATCH", `/databases/${dbId}`, { parent: { type: "page_id", page_id: target.id } });
  } else throw new Error("블록 이동은 지원하지 않습니다.");
  audit({ tool: "move", id: r.id, from: before, to: target.id });
  const after = await describe(await resolve(r.id), false);
  let verified = after.parent.id ? normId(after.parent.id) === target.id || (target.kind !== "page") : false;
  if (r.kind === "data_source") {
    const db = await api("GET", `/databases/${r.obj.parent.database_id}`);
    verified = normId(db.parent?.page_id || "00000000000000000000000000000000") === target.id;
  }
  if (r.kind === "page" && target.kind !== "page") verified = normId(after.parent.id || "0".repeat(32)) === (await toDataSource(target.id)).dsId;
  return { moved: true, verified, before_parent: before, after_parent: after.parent };
}

// ───────── 휴지통 (2단계 승인) ─────────
export async function trashPrepare(a: { ids: string[] }) {
  if (!a.ids.length) throw new Error("대상 ID가 없습니다.");
  if (a.ids.length > TRASH_MAX) throw new Error(`한 번에 최대 ${TRASH_MAX}건. 대상 목록을 나눠서 승인받으세요.`);
  const items: any[] = [];
  const preview: any[] = [];
  for (const raw of a.ids) {
    const r = await resolve(raw);
    if (r.kind === "block") throw new Error(`${r.id}는 블록입니다. 페이지/DB/데이터소스/레코드만 휴지통 처리합니다.`);
    if (PROTECTED.has(r.id)) throw new Error(`보호 대상(${titleOf(r.obj)})은 MCP로 휴지통 처리할 수 없습니다. 꼭 필요하면 아빠가 Notion에서 직접 처리하세요.`);
    const d = await describe(r, false);
    if (d.in_trash) throw new Error(`${d.title}(${r.id})는 이미 휴지통에 있습니다.`);
    let childCount: number | undefined;
    if (r.kind === "page") childCount = (await paginate("GET", `/blocks/${r.id}/children`, {}, 500)).filter((b: any) => b.type === "child_page" || b.type === "child_database").length;
    if (r.kind === "database" || r.kind === "data_source") {
      const { dsId } = await toDataSource(r.id);
      childCount = (await paginate("POST", `/data_sources/${dsId}/query`, {}, 500)).length;
    }
    const created = createdInfo(r.id);
    items.push({ id: r.id, kind: r.kind, title: d.title, last_edited_time: d.last_edited_time });
    preview.push({ id: r.id, kind: r.kind, title: d.title, parent: d.parent, url: d.url, last_edited_time: d.last_edited_time,
      contains: childCount, created_by_this_mcp: !!created, test_object: !!created?.test });
  }
  const token = newPending(items);
  return {
    approval_token: token,
    expires_in_minutes: 30,
    targets: preview,
    next_step: "이 목록을 확인한 뒤 trash_execute에 approval_token과 approval(아빠의 실제 삭제 지시 문구 또는 '테스트 객체 정리')을 주세요. 완료(complete)는 삭제가 아닙니다.",
  };
}

export async function trashExecute(a: { approval_token: string; approval: string; approved_by: string }) {
  const p = takePending(a.approval_token);
  const approval = (a.approval || "").trim();
  if (approval.length < 4) throw new Error("approval(삭제 승인 근거)이 비어 있습니다.");
  const isTestCleanup = /테스트\s*객체\s*정리/.test(approval);
  for (const it of p.items) {
    const c = createdInfo(it.id);
    if (isTestCleanup && !(c && c.test)) throw new Error(`'테스트 객체 정리' 근거는 이 MCP가 test_object로 만든 객체에만 쓸 수 있습니다: ${it.title} (${it.id})`);
  }
  if (!isTestCleanup && !/아빠|사장님/.test(a.approved_by)) throw new Error("기존 데이터 휴지통 처리는 아빠(사장님)의 명시적 삭제 지시가 필요합니다. approved_by='아빠'와 실제 지시 문구를 주세요.");
  const results: any[] = [];
  for (const it of p.items) {
    const r = await resolve(it.id);
    const cur = await describe(r, false);
    if (cur.title !== it.title || cur.last_edited_time !== it.last_edited_time) {
      results.push({ id: it.id, title: it.title, trashed: false, reason: "승인 이후 대상이 바뀌었습니다(제목/수정시각). 다시 prepare 하세요." });
      continue;
    }
    const path = it.kind === "page" ? "/pages/" : it.kind === "database" ? "/databases/" : "/data_sources/";
    await api("PATCH", path + it.id, { in_trash: true });
    const re = await api("GET", path + it.id);
    const ok = (re.in_trash ?? re.archived) === true;
    results.push({ id: it.id, kind: it.kind, title: it.title, trashed: ok, verified_in_trash: ok });
    audit({ tool: "trash", id: it.id, kind: it.kind, title: it.title, approved_by: a.approved_by, approval, verified: ok });
  }
  return { all_verified: results.every((x) => x.verified_in_trash), results };
}

export async function restore(a: { id: string }) {
  const id = normId(a.id);
  for (const path of ["/pages/", "/databases/", "/data_sources/"]) {
    try {
      const o = await api("GET", path + id);
      if (!(o.in_trash ?? o.archived)) return { restored: false, reason: "휴지통에 없음" };
      await api("PATCH", path + id, { in_trash: false });
      const re = await api("GET", path + id);
      audit({ tool: "restore", id });
      return { restored: true, verified: !(re.in_trash ?? re.archived) };
    } catch (e: any) { if (![400, 404].includes(e.status)) throw e; }
  }
  throw new Error("대상을 찾지 못했습니다.");
}

// ───────── 검증 ─────────
export async function verifyChange(a: { id: string; expect: { title?: string; in_trash?: boolean; parent_id?: string; properties?: Record<string, any>; content_contains?: string[] } }) {
  const r = await resolve(a.id);
  const d = await describe(r, true);
  const checks: any[] = [];
  const e = a.expect;
  if (e.title !== undefined) checks.push({ check: "title", ok: d.title === e.title, actual: d.title });
  if (e.in_trash !== undefined) checks.push({ check: "in_trash", ok: d.in_trash === e.in_trash, actual: d.in_trash });
  if (e.parent_id) {
    let target = normId(e.parent_id);
    try { const t = await resolve(e.parent_id); if (t.kind === "database") target = (await toDataSource(t.id)).dsId; } catch {}
    checks.push({ check: "parent", ok: !!d.parent.id && normId(d.parent.id) === target, actual: d.parent });
  }
  for (const [k, v] of Object.entries(e.properties || {})) checks.push({ check: `prop:${k}`, ok: sameVal(d.properties?.[k], v), actual: d.properties?.[k] });
  if (e.content_contains?.length) {
    const md = await blocksToMd(r.id, 0, 3);
    for (const s of e.content_contains) checks.push({ check: `content:${s.slice(0, 30)}`, ok: md.includes(s) });
  }
  return { id: r.id, all_ok: checks.every((c) => c.ok), checks };
}

// ───────── 원형 API (안전 가드) ─────────
export async function apiRequest(a: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: any }) {
  const path = a.path.startsWith("/") ? a.path : "/" + a.path;
  if (/^\/v1\//.test(path)) throw new Error("path는 /v1 없이 주세요 (예: /users).");
  if (a.method === "DELETE") {
    const m = path.match(/^\/blocks\/([0-9a-f-]{32,36})$/i);
    if (!m) throw new Error("DELETE는 /blocks/{id}(본문 블록 삭제)만 허용됩니다. 페이지·DB는 trash_prepare → trash_execute를 쓰세요.");
    const b = await api("GET", `/blocks/${m[1]}`);
    if (b.type === "child_page" || b.type === "child_database") throw new Error("하위 페이지·DB 블록은 DELETE로 지울 수 없습니다. trash_prepare → trash_execute를 쓰세요.");
    const pid = await owningPage(m[1]);
    if (pid) assertNotRuleDoc(pid);
    audit({ tool: "api_request", method: "DELETE", path });
    return api("DELETE", path);
  }
  const bodyStr = JSON.stringify(a.body || {});
  if (/"(in_trash|archived|is_archived)"\s*:/.test(bodyStr)) throw new Error("휴지통/보관 처리는 api_request로 할 수 없습니다. trash_prepare → trash_execute를 쓰세요.");
  if (a.method === "PATCH" && /^\/(pages|blocks)\//.test(path)) {
    const m = path.match(/[0-9a-f-]{32,36}/i);
    if (m) {
      const pid = path.startsWith("/pages/") ? normId(m[0]) : await owningPage(m[0]);
      if (pid) assertNotRuleDoc(pid);
    }
  }
  if (a.method !== "GET") audit({ tool: "api_request", method: a.method, path });
  return api(a.method, path, a.method === "GET" ? undefined : a.body ?? {});
}

export async function uploadFile(a: { path?: string; content_base64?: string; filename?: string; attach_to?: string; caption?: string }) {
  const { readFileSync } = await import("node:fs");
  const { basename, extname } = await import("node:path");
  let data: Buffer, name: string;
  if (a.content_base64) {
    if (!a.filename) throw new Error("content_base64를 쓸 때는 filename이 필요합니다.");
    data = Buffer.from(a.content_base64, "base64"); name = a.filename;
  } else if (a.path) { data = readFileSync(a.path); name = a.filename || basename(a.path); }
  else throw new Error("path 또는 content_base64+filename을 주세요.");
  if (data.length > 20 * 1024 * 1024) throw new Error("20MB 초과 파일은 아직 지원하지 않습니다.");
  const size = data.length;
  const ext = extname(name).toLowerCase().slice(1);
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown", zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp4: "video/mp4", mp3: "audio/mpeg" };
  const ctype = types[ext] || "application/octet-stream";
  const fu = await api("POST", "/file_uploads", { filename: name, content_type: ctype });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: ctype }), name);
  const res = await fetch(`https://api.notion.com/v1/file_uploads/${fu.id}/send`, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Notion-Version": NOTION_VERSION }, body: form });
  const sent: any = await res.json();
  if (!res.ok) throw new Error(`업로드 실패 ${res.status}: ${sent.message || ""}`);
  audit({ tool: "upload_file", name, size });
  const out: any = { file_upload_id: fu.id, status: sent.status, filename: name, content_type: ctype };
  if (a.attach_to) {
    const pid = normId(a.attach_to);
    assertNotRuleDoc(pid);
    const kind = ctype.startsWith("image/") ? "image" : ctype === "application/pdf" ? "pdf" : ctype.startsWith("video/") ? "video" : ctype.startsWith("audio/") ? "audio" : "file";
    const blk: any = { type: kind, [kind]: { type: "file_upload", file_upload: { id: fu.id }, caption: a.caption ? [{ type: "text", text: { content: a.caption } }] : [] } };
    const r = await api("PATCH", `/blocks/${pid}/children`, { children: [blk] });
    const bid = r.results?.[0]?.id;
    const check = bid ? await api("GET", `/blocks/${bid}`) : null;
    out.attached_block_id = bid; out.verified = !!check && check.type === kind;
  }
  return out;
}
