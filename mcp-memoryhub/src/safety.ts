// 공통 안전 계층 — 전용 도구와 원형 api_request가 "같은 기준"으로 검사한다.
// 여기 있는 규칙은 운영정책이 아니라 우회되면 안 되는 안전장치라서 코드로 강제한다.
//   · 운영규칙 문서(「공용 규칙 문서 목록」 표)는 rules_update 외에는 수정·하위 생성 불가
//   · 보호 객체(핵심 DB·페이지 + 운영규칙 문서)는 휴지통 불가, 이동은 아빠 지시 근거 필수
//   · 보호 DB 스키마는 속성 삭제·이름 변경·타입 변경·선택지 삭제 불가(추가만 허용)
//   · 작업 원장의 상태·완료일시는 task_start/task_finish(종료 게이트)로만 변경
//   · 휴지통 처리는 trash_prepare → trash_execute 2단계로만
import { api, normId } from "./notion.js";
import { IDS, PROTECTED, owningPage, createdInfo } from "./core.js";
import { getPolicy, PROPS } from "./policy.js";
import { titleOf } from "./format.js";

export const TEST_PREFIX = process.env.WOOS_TEST_PREFIX || "[MCP테스트] ";
const TEST_MAX_AGE_H = Number(process.env.WOOS_TEST_MAX_AGE_H || 72);
const FALLBACK_RULE_DOCS = [IDS.rules, IDS.rulesExec, IDS.rulesIdentity, IDS.rulesDev].map(normId);

/** 운영규칙 문서 ID 집합 — 정본은 운영규칙의 「공용 규칙 문서 목록」 표. 표를 못 읽으면 안전 쪽(기본 4개)으로 보호 */
export async function ruleDocIds(): Promise<Set<string>> {
  const p = await getPolicy();
  const ids = p.ruleDocs.length ? p.ruleDocs.map((d) => d.id) : FALLBACK_RULE_DOCS;
  return new Set([normId(IDS.rules), ...ids]);
}
export async function isRuleDoc(id: string) { return (await ruleDocIds()).has(normId(id)); }
export async function assertNotRuleDoc(pageId: string) {
  if (await isRuleDoc(pageId))
    throw new Error("운영규칙 문서는 일반 쓰기 도구·원형 API로 수정하거나 그 아래에 만들 수 없습니다. 아빠의 명시적 지시가 있을 때 rules_update를 사용하세요.");
}
export async function isProtected(id: string) { const n = normId(id); return PROTECTED.has(n) || (await isRuleDoc(n)); }

export async function assertMoveAllowed(id: string, dadInstruction?: string) {
  if (await isProtected(id)) {
    if (!dadInstruction || dadInstruction.trim().length < 8)
      throw new Error("보호 객체(핵심 DB·페이지·운영규칙)는 아빠의 명시적 지시가 있을 때만 이동합니다. move의 dad_instruction에 아빠의 실제 지시 문구를 적으세요.");
  }
}

/** 보호 DB 스키마: 추가만 허용 */
export async function assertSchemaChange(dsId: string, ds: any, body: any) {
  if (!(await isProtected(dsId)) && !(ds?.parent?.database_id && (await isProtected(ds.parent.database_id)))) return;
  for (const [k, v] of Object.entries<any>(body?.properties || {})) {
    const cur = ds.properties[k];
    if (!cur) continue; // 새 속성 추가는 허용
    if (v === null) throw new Error(`보호 DB의 속성 삭제 금지: ${k}`);
    if (v.name && v.name !== k) throw new Error(`보호 DB의 속성 이름 변경 금지: ${k}`);
    if (v.type && v.type !== cur.type) throw new Error(`보호 DB의 속성 타입 변경 금지: ${k}`);
    const t = cur.type;
    if (["select", "multi_select", "status"].includes(t) && v[t]?.options) {
      const next = new Set(v[t].options.map((o: any) => o.name ?? o.id));
      const nextIds = new Set(v[t].options.map((o: any) => o.id).filter(Boolean));
      const lost = cur[t].options.filter((o: any) => !next.has(o.name) && !nextIds.has(o.id)).map((o: any) => o.name);
      if (lost.length) throw new Error(`보호 DB의 선택지 삭제 금지: ${k} → ${lost.join(", ")}`);
    }
    for (const kk of Object.keys(v)) if (kk !== "name" && kk !== "type" && kk !== t && kk !== "description")
      throw new Error(`보호 DB 속성 ${k}의 정의 변경(${kk}) 금지`);
  }
  if (body?.in_trash !== undefined || body?.archived !== undefined) throw new Error("휴지통 처리는 trash_prepare → trash_execute로만");
}

/** 작업 원장 레코드의 상태·완료일시를 일반 경로로 바꾸는 것 금지 */
export async function assertTaskDirectWrite(page: any, propNames: string[]) {
  const dsId = page?.parent?.data_source_id;
  if (!dsId || normId(dsId) !== normId(IDS.taskDs)) return;
  const locked = [PROPS.status, PROPS.doneAt].filter((k) => propNames.includes(k));
  if (locked.length) throw new Error(`작업 원장의 ${locked.join("·")}는 task_start/task_finish(종료 게이트)로만 바꿉니다.`);
}

/** 테스트 객체 판정 — 로컬 기록 또는 (이 통합이 최근 만든 + 테스트 접두어) */
let botId: string | null = null;
export async function isTestObject(id: string, obj?: any): Promise<boolean> {
  const c = createdInfo(id);
  if (c?.test) return true;
  if (!obj) return false;
  if (!botId) botId = normId((await api("GET", "/users/me")).id);
  const by = obj.created_by?.id ? normId(obj.created_by.id) : null;
  const ageH = (Date.now() - Date.parse(obj.created_time || 0)) / 3600000;
  return by === botId && titleOf(obj).startsWith(TEST_PREFIX.trim()) && ageH >= 0 && ageH <= TEST_MAX_AGE_H;
}

// ───────── 원형 API 가드 (허용 목록 방식) ─────────
const ID = "([0-9a-fA-F-]{32,36})";
const R = (s: string) => new RegExp("^" + s.replace(/\{id\}/g, ID) + "(\\?.*)?$");
const READ_POST = [R("/search"), R("/data_sources/{id}/query"), R("/databases/{id}/query")];

export async function guardRaw(method: string, path: string, body: any) {
  if (method === "GET") return;
  if (READ_POST.some((r) => r.test(path)) && method === "POST") return;
  const s = JSON.stringify(body || {});
  if (/"(in_trash|archived|is_archived)"\s*:/.test(s)) throw new Error("휴지통/보관 처리는 api_request로 할 수 없습니다. trash_prepare → trash_execute를 쓰세요.");
  let m: RegExpMatchArray | null;

  // 블록
  if (method === "DELETE") {
    if (!(m = path.match(R("/blocks/{id}")))) throw new Error("DELETE는 /blocks/{id}(본문 블록 삭제)만 허용됩니다. 페이지·DB는 trash_prepare → trash_execute를 쓰세요.");
    const b = await api("GET", `/blocks/${m[1]}`);
    if (b.type === "child_page" || b.type === "child_database") throw new Error("하위 페이지·DB 블록은 DELETE로 지울 수 없습니다. trash_prepare → trash_execute를 쓰세요.");
    const pid = await owningPage(m[1]); if (pid) await assertNotRuleDoc(pid);
    return;
  }
  if (method === "PATCH" && ((m = path.match(R("/blocks/{id}"))) || (m = path.match(R("/blocks/{id}/children"))))) {
    const pid = await owningPage(m[1]); if (pid) await assertNotRuleDoc(pid);
    if (path.endsWith("/children") && /"type"\s*:\s*"child_(page|database)"/.test(s)) throw new Error("원형 API로 하위 페이지·DB 블록을 만들 수 없습니다. create_page/create_database를 쓰세요.");
    return;
  }

  // 페이지
  if (method === "POST" && R("/pages").test(path)) {
    const par = body?.parent || {};
    if (par.page_id) await assertNotRuleDoc(par.page_id);
    const ds = par.data_source_id || par.database_id;
    if (ds && [IDS.taskDs, IDS.taskDb].map(normId).includes(normId(ds))) throw new Error("작업 원장 레코드는 task_create로만 만듭니다(중복 검색·프로젝트 연결·입력자 기록).");
    return;
  }
  if (method === "PATCH" && (m = path.match(R("/pages/{id}")))) {
    await assertNotRuleDoc(m[1]);
    if (body?.parent) throw new Error("원형 API로 페이지를 옮길 수 없습니다. move를 쓰세요(보호 객체는 아빠 지시 필요).");
    const page = await api("GET", `/pages/${m[1]}`);
    await assertTaskDirectWrite(page, Object.keys(body?.properties || {}));
    return;
  }
  if (method === "POST" && R("/pages/{id}/move").test(path)) throw new Error("원형 API로 페이지를 옮길 수 없습니다. move를 쓰세요.");

  // DB·데이터소스
  if (method === "POST" && R("/databases").test(path)) { if (body?.parent?.page_id) await assertNotRuleDoc(body.parent.page_id); return; }
  if (method === "POST" && R("/data_sources").test(path)) {
    const db = body?.parent?.database_id; if (db && (await isProtected(db))) throw new Error("보호 DB에 데이터소스를 추가할 수 없습니다.");
    return;
  }
  if (method === "PATCH" && ((m = path.match(R("/data_sources/{id}"))) || (m = path.match(R("/databases/{id}"))))) {
    if (body?.parent) throw new Error("원형 API로 DB를 옮길 수 없습니다. move를 쓰세요.");
    const isDs = path.startsWith("/data_sources/");
    const obj = await api("GET", (isDs ? "/data_sources/" : "/databases/") + m[1]);
    if (isDs) await assertSchemaChange(normId(m[1]), obj, body);
    else if (await isProtected(m[1])) throw new Error("보호 DB 정의는 원형 API로 바꿀 수 없습니다. update_schema를 쓰세요.");
    return;
  }

  // 그 밖의 쓰기
  if (method === "POST" && (R("/comments").test(path) || R("/file_uploads").test(path) || R("/file_uploads/{id}/send").test(path) || R("/file_uploads/{id}/complete").test(path))) return;
  throw new Error(`api_request 허용 목록에 없는 쓰기 요청입니다: ${method} ${path}. 전용 도구를 쓰거나 필요하면 허용 목록 추가를 요청하세요.`);
}
