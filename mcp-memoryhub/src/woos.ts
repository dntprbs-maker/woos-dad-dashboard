// WOO'S 전용 도구: 작업 원장 절차(운영규칙 「작업 원장 사용 절차」 2026-10-05), 운영규칙, 작업일지, 직원
import { api, paginate, normId } from "./notion.js";
import { titleOf, simplifyProps, buildProps, rt, mdToBlocks, appendBlocks, blocksToMd, plain } from "./format.js";
import { IDS, audit, RULE_DOCS, resolve, markCreated } from "./core.js";
import { writeContent, query, sameVal } from "./generic.js";

const STATUSES = ["미착수", "진행중", "대기", "보류", "완료", "계획·아이디어"] as const;
const AI_PRIORITIES = ["상", "중", "하"];

function nowKst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}
const todayKst = () => nowKst().slice(0, 10);

let taskSchema: any;
async function schema() {
  if (!taskSchema) taskSchema = (await api("GET", `/data_sources/${IDS.taskDs}`)).properties;
  return taskSchema;
}

async function readTask(id: string) {
  const p = await api("GET", `/pages/${normId(id)}`);
  if (p.parent?.data_source_id && normId(p.parent.data_source_id) !== normId(IDS.taskDs)) throw new Error("작업 원장의 작업이 아닙니다.");
  return { page: p, props: await simplifyProps(p) };
}

function summarize(p: any, props: any, full = false): any {
  const 작업내용: string = props["작업내용"] || "";
  return {
    id: p.id, url: p.url, 작업명: props["작업명"], 상태: props["상태"], 우선순위: props["우선순위"], 작업자: props["작업자"],
    프로젝트명: props["프로젝트명"], 작업일: props["작업일"], 완료일시: props["완료일시"], 아빠개입: props["아빠 개입"],
    개입요청내용: props["개입 요청 내용"], 확인필요: props["확인필요"], in_trash: p.in_trash,
    ...(full
      ? { 작업내용: 작업내용, 결정사항: props["결정사항"], 관련파일: props["관련파일"], GitCommit: props["Git Commit"], 비고: props["비고"], 의뢰자: props["의뢰자"], 입력자: props["입력자"], 프로젝트: props["프로젝트"] }
      : { 최근기록: 작업내용.slice(-400) }),
  };
}

/** rich_text 속성 끝에 "[YYYY-MM-DD HH:MM] text"를 덧붙인다 (기존 서식 보존) */
function appendRt(page: any, prop: string, text: string): any {
  const cur: any[] = page.properties[prop]?.rich_text || [];
  const add = rt((cur.length ? "\n" : "") + `[${nowKst()}] ${text}`);
  let next = [...cur.map((r: any) => ({ type: "text", text: { content: r.plain_text, link: r.href ? { url: r.href } : null }, annotations: r.annotations })), ...add];
  if (next.length > 100) next = rt(plain(cur) + (cur.length ? "\n" : "") + `[${nowKst()}] ${text}`).slice(-100);
  return { rich_text: next };
}

// ───────── 조회 ─────────
export async function taskSearch(a: { query?: string; status?: string | string[]; include_done_days?: number; project?: string; worker?: string; limit?: number }) {
  // Notion 복합필터 중첩 한도(2단계)에 맞춰 "공통조건 AND 상태조건"을 분기마다 펼쳐서 OR로 묶는다
  const common: any[] = [];
  if (a.query) common.push({ property: "작업명", title: { contains: a.query } });
  if (a.project) common.push({ property: "프로젝트명", rich_text: { contains: a.project } });
  if (a.worker) common.push({ property: "작업자", select: { equals: a.worker } });
  const branches: any[][] = [];
  const st = a.status ? (Array.isArray(a.status) ? a.status : [a.status]) : null;
  if (st) for (const s of st) branches.push([{ property: "상태", select: { equals: s } }]);
  else {
    branches.push([{ property: "상태", select: { does_not_equal: "완료" } }]); // 미완료(빈 값 포함)
    if (a.include_done_days) {
      const since = new Date(Date.now() - a.include_done_days * 86400000).toISOString().slice(0, 10);
      branches.push([{ property: "상태", select: { equals: "완료" } }, { property: "완료일시", date: { on_or_after: since } }]);
    }
  }
  const ands = branches.map((b) => [...common, ...b]).map((c) => (c.length === 1 ? c[0] : { and: c }));
  const filter = ands.length === 1 ? ands[0] : { or: ands };
  const rows = await paginate("POST", `/data_sources/${IDS.taskDs}/query`, { filter, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] }, a.limit ?? 30);
  const out = [];
  for (const p of rows) out.push(summarize(p, await simplifyProps(p, false)));
  return { count: out.length, tasks: out };
}

export async function taskGet(a: { id: string }) {
  const { page, props } = await readTask(a.id);
  return summarize(page, props, true);
}

// ───────── 등록 ─────────
async function findProject(name: string): Promise<string | null> {
  const rows = await paginate("POST", `/data_sources/${IDS.projectDs}/query`, {}, 300);
  const hit = rows.find((p: any) => titleOf(p).trim().toLowerCase() === name.trim().toLowerCase());
  return hit ? hit.id : null;
}

const tokens = (s: string) => s.replace(/\[[^\]]*\]/g, " ").split(/[\s,·/()\-—:]+/).filter((w) => w.length >= 2);

export async function taskCreate(a: {
  project: string; title: string; content: string; status?: "미착수" | "진행중" | "계획·아이디어"; priority?: string;
  worker?: string; requester?: string; distinct_from?: { ids: string[]; reason: string }; extra?: Record<string, any>; test_object?: boolean;
}) {
  if (a.priority && !AI_PRIORITIES.includes(a.priority)) throw new Error("AI는 우선순위를 상/중/하만 지정할 수 있습니다. 최상·최하는 아빠 전용입니다.");
  const title = a.title.trim().startsWith(`[${a.project}]`) ? a.title.trim() : `[${a.project}] ${a.title.trim()}`;
  // 1) 기존 작업 먼저 검색: 미완료 전체 + 최근 7일 완료, 제목 키워드 겹침으로 후보 판정
  const pool = (await taskSearch({ include_done_days: 7, limit: 400 })).tasks;
  const kw = tokens(a.title);
  const candidates = pool
    .map((t: any) => ({ t, score: kw.filter((w) => (t.작업명 || "").includes(w)).length }))
    .filter((x) => x.score >= Math.max(2, Math.ceil(kw.length * 0.5)) || (x.t.작업명 || "").includes(a.title.trim()))
    .sort((x, y) => y.score - x.score)
    .slice(0, 8)
    .map((x) => ({ id: x.t.id, 작업명: x.t.작업명, 상태: x.t.상태 }));
  const declared = new Set((a.distinct_from?.ids || []).map(normId));
  const undeclared = candidates.filter((c) => !declared.has(normId(c.id)));
  if (undeclared.length) {
    return {
      created: false,
      reason: "유사한 기존 작업이 있습니다. 같은 작업이면 새로 만들지 말고 task_update/task_start로 기존 작업을 갱신하세요. 정말 다른 작업이면 distinct_from에 후보 ID와 다른 이유를 적어 다시 호출하세요 (강제 생성 옵션은 없습니다).",
      duplicate_candidates: undeclared,
    };
  }
  if (a.distinct_from && (!a.distinct_from.reason || a.distinct_from.reason.trim().length < 5)) throw new Error("distinct_from.reason에 왜 다른 작업인지 구체적으로 적으세요.");
  const s = await schema();
  const projectId = await findProject(a.project);
  const vals: any = {
    작업명: title, 상태: a.status || "미착수", 우선순위: a.priority || "중", 프로젝트명: a.project,
    작업자: a.worker || "Claude Code", 의뢰자: a.requester || "아빠", 입력자: "코드디", 작업일: todayKst(),
    ...(projectId ? { 프로젝트: [projectId] } : {}), ...(a.extra || {}),
  };
  const props = buildProps(s, vals);
  props["작업내용"] = { rich_text: rt(`[${nowKst()}] ${a.content}`) };
  const page = await api("POST", "/pages", { parent: { type: "data_source_id", data_source_id: IDS.taskDs }, properties: props });
  markCreated(page.id, "page", title, !!a.test_object);
  audit({ tool: "task_create", id: page.id, title, distinct_from: a.distinct_from });
  const re = await readTask(page.id);
  return { created: true, project_linked: !!projectId, verified: re.props["작업명"] === title && re.props["상태"] === vals.상태, task: summarize(re.page, re.props) };
}

// ───────── 시작 ─────────
export async function taskStart(a: { id: string; note: string; worker?: string; reopen_completed?: boolean }) {
  const { page, props } = await readTask(a.id);
  if (page.in_trash) throw new Error("휴지통에 있는 작업입니다.");
  if (props["상태"] === "완료" && !a.reopen_completed) throw new Error("이미 완료된 작업입니다. 다시 열려면 reopen_completed=true와 이유(note)를 주세요. 별개 후속 작업이면 task_create로 등록하세요.");
  const before = summarize(page, props, true);
  const body: any = { properties: { 상태: { select: { name: "진행중" } }, 작업내용: appendRt(page, "작업내용", `작업 시작${props["상태"] === "완료" ? "(재개)" : ""}: ${a.note}`) } };
  if (a.worker) body.properties.작업자 = { select: { name: a.worker } };
  if (props["아빠 개입"] && props["아빠 개입"] !== "없음") {
    // 시작 시점의 개입 표시는 유지 (해소되면 task_update intervention=없음)
  }
  await api("PATCH", `/pages/${page.id}`, body);
  audit({ tool: "task_start", id: page.id, from: props["상태"] });
  const after = await readTask(page.id);
  const ok = after.props["상태"] === "진행중";
  return {
    verified: ok, status_before: props["상태"], status_after: after.props["상태"],
    prior_record: { 결정사항: before.결정사항, 관련파일: before.관련파일, GitCommit: before.GitCommit, 최근기록: (before.작업내용 || "").slice(-1500), 아빠개입: before.아빠개입, 개입요청내용: before.개입요청내용 },
    reminder: "진행 중 중요한 결과·결정·문제·다음 단계는 task_update로 수시 기록하고, 끝낼 때는 반드시 task_finish로 종료 게이트를 통과하세요.",
  };
}

// ───────── 진행 기록 ─────────
export async function taskUpdate(a: {
  id: string; progress?: string; decision?: string; files?: string; commits?: string; note?: string; priority?: string;
  intervention?: { type: "없음" | "의사결정" | "직접조작"; request?: string };
}) {
  const { page, props } = await readTask(a.id);
  const p: any = {};
  if (a.progress) p.작업내용 = appendRt(page, "작업내용", a.progress);
  if (a.decision) p.결정사항 = appendRt(page, "결정사항", a.decision);
  if (a.files) p.관련파일 = appendRt(page, "관련파일", a.files);
  if (a.commits) p["Git Commit"] = appendRt(page, "Git Commit", a.commits);
  if (a.note) p.비고 = appendRt(page, "비고", a.note);
  if (a.priority) {
    if (!AI_PRIORITIES.includes(a.priority)) throw new Error("AI는 상/중/하만 지정할 수 있습니다 (최상·최하는 아빠 전용).");
    if (["최상", "최하"].includes(props["우선순위"])) throw new Error(`현재 우선순위 '${props["우선순위"]}'는 아빠가 지정한 값이라 AI가 바꾸지 않습니다.`);
    p.우선순위 = { select: { name: a.priority } };
  }
  if (a.intervention) {
    if (a.intervention.type !== "없음" && !(a.intervention.request || "").trim()) throw new Error("의사결정/직접조작이면 request(아빠가 무엇을 해야 하는지)를 구체적으로 적어야 합니다.");
    p["아빠 개입"] = { select: { name: a.intervention.type } };
    p["개입 요청 내용"] = { rich_text: a.intervention.type === "없음" ? [] : rt(a.intervention.request!) };
  }
  if (!Object.keys(p).length) throw new Error("기록할 내용이 없습니다.");
  await api("PATCH", `/pages/${page.id}`, { properties: p });
  audit({ tool: "task_update", id: page.id, keys: Object.keys(p) });
  const after = await readTask(page.id);
  const problems: string[] = [];
  if (a.progress && !(after.props["작업내용"] || "").includes(a.progress.slice(0, 50))) problems.push("작업내용 미반영");
  if (a.intervention && after.props["아빠 개입"] !== a.intervention.type) problems.push("아빠 개입 미반영");
  if (a.priority && after.props["우선순위"] !== a.priority) problems.push("우선순위 미반영");
  return { verified: problems.length === 0, problems, status: after.props["상태"], note: "상태 변경(완료·대기·보류)은 task_finish로 합니다." };
}

// ───────── 종료 게이트 ─────────
export async function taskFinish(a: {
  id: string; outcome: "완료" | "진행중" | "대기" | "보류"; result: string; verification?: string; unresolved?: string;
  next_steps?: string; waiting_for?: string; hold_reason?: string; files?: string; commits?: string;
  needs_dad_confirmation?: boolean; dad_confirmed?: string; intervention?: { type: "없음" | "의사결정" | "직접조작"; request?: string };
}) {
  const { page, props } = await readTask(a.id);
  const before = props["상태"];
  const errs: string[] = [];
  if (!a.result?.trim()) errs.push("result(실제 결과)가 비어 있음");
  if (a.outcome === "완료") {
    if (!a.verification?.trim() || a.verification.trim().length < 10) errs.push("완료하려면 verification(실제 검증 결과)을 구체적으로 적어야 함 — 조사·코드 작성·보고만으로는 완료 불가");
    if (a.needs_dad_confirmation && !a.dad_confirmed?.trim()) errs.push("아빠 확인이 성공조건인 작업은 아빠 확인 전 완료 불가 → outcome=진행중 + needs_dad_confirmation=true로 '아빠 확인대기'를 기록하세요");
    if (a.unresolved?.trim()) errs.push("미해결(unresolved)이 남아 있는데 완료로 닫으려 함 — 별개 후속이면 따로 등록하고 unresolved를 비우세요");
  }
  if (a.outcome === "진행중" && !a.next_steps?.trim()) errs.push("진행중 유지 시 정확한 next_steps 필수");
  if (a.outcome === "대기" && !a.waiting_for?.trim()) errs.push("대기는 스스로 해소할 수 없는 외부 조건일 때만 — waiting_for(무엇을 기다리는지) 필수. '다음 지시 대기'는 대기가 아니라 미착수/진행중");
  if (a.outcome === "대기" && a.waiting_for && /다음\s*(지시|작업|일)|지시를?\s*기다/.test(a.waiting_for)) errs.push("'다음 지시를 기다림'은 대기 사유가 아님 (운영규칙 상태 의미)");
  if (a.outcome === "보류" && !a.hold_reason?.trim()) errs.push("보류는 의도적 중단 결정일 때만 — hold_reason 필수");
  if (a.outcome === "보류" && a.hold_reason && /아빠\s*(부재|없|외출)|장비|장소/.test(a.hold_reason)) errs.push("아빠 부재·장소·장비 문제는 보류 사유가 아님 (운영규칙 23) — 아빠 개입 속성을 쓰세요");
  if (errs.length) return { finished: false, gate: "rejected", errors: errs, status_unchanged: before };

  const lines = [`작업 종료 처리(${before} → ${a.outcome}${a.needs_dad_confirmation && a.outcome === "진행중" ? ", 아빠 확인대기" : ""})`, `결과: ${a.result}`];
  if (a.verification) lines.push(`검증: ${a.verification}`);
  if (a.unresolved) lines.push(`미해결: ${a.unresolved}`);
  if (a.next_steps) lines.push(`다음 단계: ${a.next_steps}`);
  if (a.waiting_for) lines.push(`대기 사유(외부 조건): ${a.waiting_for}`);
  if (a.hold_reason) lines.push(`보류 사유: ${a.hold_reason}`);
  if (a.dad_confirmed) lines.push(`아빠 확인: ${a.dad_confirmed}`);
  const p: any = { 상태: { select: { name: a.outcome } }, 작업내용: appendRt(page, "작업내용", lines.join("\n")) };
  if (a.files) p.관련파일 = appendRt(page, "관련파일", a.files);
  if (a.commits) p["Git Commit"] = appendRt(page, "Git Commit", a.commits);
  if (a.outcome === "완료") {
    p.완료일시 = { date: { start: new Date().toISOString() } };
    p["아빠 개입"] = { select: { name: "없음" } };
    p["개입 요청 내용"] = { rich_text: [] };
    p.확인필요 = { checkbox: false };
  } else {
    if (props["완료일시"]) p.완료일시 = { date: null };
    if (a.needs_dad_confirmation !== undefined) p.확인필요 = { checkbox: !!a.needs_dad_confirmation };
    if (a.intervention) {
      if (a.intervention.type !== "없음" && !a.intervention.request?.trim()) return { finished: false, gate: "rejected", errors: ["intervention.request 필요"], status_unchanged: before };
      p["아빠 개입"] = { select: { name: a.intervention.type } };
      p["개입 요청 내용"] = { rich_text: a.intervention.type === "없음" ? [] : rt(a.intervention.request!) };
    }
  }
  await api("PATCH", `/pages/${page.id}`, { properties: p });
  audit({ tool: "task_finish", id: page.id, from: before, to: a.outcome });

  // 재조회 → 실제 상태와 원장 일치 검증
  const re = await readTask(page.id);
  const checks: any[] = [
    { check: "상태", ok: re.props["상태"] === a.outcome, actual: re.props["상태"] },
    { check: "종료기록", ok: (re.props["작업내용"] || "").includes(`결과: ${a.result}`.slice(0, 60)) },
  ];
  if (a.outcome === "완료") {
    checks.push({ check: "완료일시", ok: !!re.props["완료일시"], actual: re.props["완료일시"] });
    checks.push({ check: "아빠 개입=없음", ok: re.props["아빠 개입"] === "없음" || re.props["아빠 개입"] == null });
  } else checks.push({ check: "완료일시 비어 있음", ok: !re.props["완료일시"], actual: re.props["완료일시"] });
  if (a.needs_dad_confirmation !== undefined && a.outcome !== "완료") checks.push({ check: "확인필요", ok: re.props["확인필요"] === !!a.needs_dad_confirmation });
  return { finished: true, verified: checks.every((c) => c.ok), checks, task: summarize(re.page, re.props) };
}

// ───────── 운영규칙 ─────────
const RULE_ALIASES: Record<string, string> = {
  운영규칙: IDS.rules, "woo's 메모리허브 운영규칙": IDS.rules, rules: IDS.rules,
  "실행·종료": IDS.rulesExec, "AI 작업자 실행·종료 규칙": IDS.rulesExec, exec: IDS.rulesExec,
  정체성: IDS.rulesIdentity, "AI 가족·작업자 정체성 및 명칭 규칙": IDS.rulesIdentity, identity: IDS.rulesIdentity,
  "개발 주의사항": IDS.rulesDev, "AI 개발 공통 주의사항": IDS.rulesDev, dev: IDS.rulesDev,
};
function ruleId(doc?: string): string {
  const id = RULE_ALIASES[(doc || "운영규칙").trim()] || doc!;
  const n = normId(id);
  if (!RULE_DOCS.has(n)) throw new Error(`운영규칙 문서가 아닙니다: ${doc}. 가능: 운영규칙 / 실행·종료 / 정체성 / 개발 주의사항`);
  return n;
}

export async function rulesGet(a: { doc?: string; section?: string }) {
  const id = ruleId(a.doc);
  const p = await api("GET", `/pages/${id}`);
  let md = await blocksToMd(id, 0, 3, { n: 0, max: 3000 });
  if (a.section) {
    const parts = md.split(/\n(?=#{1,3} )/);
    const hit = parts.filter((s) => s.split("\n")[0].includes(a.section!));
    md = hit.length ? hit.join("\n") : `(섹션 "${a.section}" 없음)`;
  }
  return { id, title: titleOf(p), last_edited_time: p.last_edited_time, markdown: md };
}

export async function rulesUpdate(a: { doc?: string; dad_instruction: string; mode: "append_section" | "replace_text"; markdown?: string; old_text?: string; new_text?: string }) {
  if (!a.dad_instruction || a.dad_instruction.trim().length < 8) throw new Error("운영규칙 변경은 아빠의 명시적 지시가 있을 때만 합니다. dad_instruction에 아빠의 실제 지시 문구를 그대로 적으세요.");
  const id = ruleId(a.doc);
  const res = a.mode === "append_section"
    ? await writeContent({ id, mode: "append", markdown: a.markdown }, true)
    : await writeContent({ id, mode: "replace_text", old_text: a.old_text, new_text: a.new_text }, true);
  audit({ tool: "rules_update", id, mode: a.mode, dad_instruction: a.dad_instruction.slice(0, 300) });
  return res;
}

// ───────── 날짜별 작업일지 ─────────
function worklogTitle(date: string) {
  const m = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error("date는 YYYY-MM-DD");
  return `${Number(m[1])}년 ${Number(m[2])}월 ${Number(m[3])}일 작업일지`;
}
async function findWorklog(date: string): Promise<string | null> {
  const t = worklogTitle(date);
  for (const b of await paginate("GET", `/blocks/${IDS.worklogRoot}/children`, {}, 3000))
    if (b.type === "child_page" && b.child_page.title.trim() === t) return b.id;
  return null;
}
export async function worklogGet(a: { date?: string }) {
  const date = a.date || todayKst();
  const id = await findWorklog(date);
  if (!id) return { exists: false, date, title: worklogTitle(date) };
  return { exists: true, date, id, title: worklogTitle(date), markdown: await blocksToMd(id, 0, 3) };
}
export async function worklogWrite(a: { date?: string; markdown: string; create_if_missing?: boolean; test_object?: boolean }) {
  const date = a.date || todayKst();
  let id = await findWorklog(date);
  let created = false;
  if (!id) {
    if (!a.create_if_missing) throw new Error(`${worklogTitle(date)}가 없습니다. 만들려면 create_if_missing=true.`);
    const page = await api("POST", "/pages", { parent: { type: "page_id", page_id: IDS.worklogRoot }, properties: { title: { title: rt(worklogTitle(date)) } } });
    id = page.id as string;
    created = true;
    markCreated(id, "page", worklogTitle(date), !!a.test_object);
  }
  const ids = await appendBlocks(id, mdToBlocks(a.markdown));
  audit({ tool: "worklog_write", id, date, created, blocks: ids.length });
  const md = await blocksToMd(id, 0, 2);
  const probe = a.markdown.split("\n").map((l) => l.replace(/^[#>\-*\d.\s]+/, "").replace(/\*\*|`/g, "").trim()).find((l) => l.length > 3) || "";
  return { id, created, appended_blocks: ids.length, verified: md.includes(probe.slice(0, 40)) };
}

// ───────── 직원·에이전트 ─────────
export async function employeeFind(a: { name?: string; 구분?: string; 상태?: string; id?: string }) {
  if (a.id) {
    const p = await api("GET", `/pages/${normId(a.id)}`);
    return { employees: [{ id: p.id, url: p.url, in_trash: p.in_trash, ...(await simplifyProps(p)) }] };
  }
  const where: any = {};
  if (a.name) where["이름"] = a.name;
  if (a.구분) where["구분"] = a.구분;
  if (a.상태) where["상태"] = a.상태;
  const r = await query({ id: IDS.employeeDs, where, limit: 100 });
  return { count: r.count, employees: r.rows.map((x: any) => ({ id: x.id, url: x.url, ...x.properties })) };
}
export async function employeeUpdate(a: { id: string; properties: Record<string, any> }) {
  const id = normId(a.id);
  const p = await api("GET", `/pages/${id}`);
  if (normId(p.parent?.data_source_id || "0".repeat(32)) !== normId(IDS.employeeDs)) throw new Error("직원·에이전트 DB의 항목이 아닙니다.");
  const ds = await api("GET", `/data_sources/${IDS.employeeDs}`);
  await api("PATCH", `/pages/${id}`, { properties: buildProps(ds.properties, a.properties) });
  audit({ tool: "employee_update", id, keys: Object.keys(a.properties) });
  const after = await simplifyProps(await api("GET", `/pages/${id}`));
  const mism = Object.entries(a.properties).filter(([k, v]) => !sameVal(after[k], v)).map(([k]) => k);
  return { verified: mism.length === 0, mismatches: mism, employee: after };
}

export { resolve };
