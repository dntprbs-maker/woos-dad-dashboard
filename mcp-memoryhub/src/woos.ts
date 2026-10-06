// WOO'S 전용 도구: 작업 원장·운영규칙·작업일지·직원
// 업무정책(상태·우선순위·아빠 전용 값·작업명 규칙·작업일 기준·규칙 문서 목록·직원 이름)은 policy.ts가
// Notion 원본에서 읽는다. 여기에는 정책 값을 박지 않고, 종료 게이트 같은 안전장치만 둔다.
import { api, paginate, normId } from "./notion.js";
import { titleOf, simplifyProps, buildProps, rt, mdToBlocks, appendBlocks, blocksToMd, plain } from "./format.js";
import { IDS, audit, resolve, markCreated } from "./core.js";
import { writeContent, query, sameVal } from "./generic.js";
import { getPolicy, peekPolicy, PROPS, STATUS_NAMES, INTERVENTION_NONE, currentWorkday, displayName } from "./policy.js";
import { ruleDocIds, TEST_PREFIX } from "./safety.js";
import { currentCaller } from "./context.js";

function nowKst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}
/** 기록 머리표: [YYYY-MM-DD HH:MM · 호출자] */
const stamp = () => { const c = currentCaller(); return `[${nowKst()}${c ? " · " + c : ""}]`; };

let taskSchema: any;
let taskSchemaAt = 0;
async function schema() {
  if (!taskSchema || Date.now() - taskSchemaAt > 300000) { taskSchema = (await api("GET", `/data_sources/${IDS.taskDs}`)).properties; taskSchemaAt = Date.now(); }
  return taskSchema;
}

async function readTask(id: string) {
  await getPolicy(); // summarize가 담당자 relation id → 이름 변환에 쓰는 직원 목록
  const p = await api("GET", `/pages/${normId(id)}`);
  if (!p.parent?.data_source_id || normId(p.parent.data_source_id) !== normId(IDS.taskDs)) throw new Error("작업 원장의 작업이 아닙니다.");
  return { page: p, props: await simplifyProps(p) };
}

/** 담당자 relation(직원·에이전트 id 배열) → 표시 이름 배열. 정책 미로드/미등록 id는 id 그대로 */
function assigneeNames(props: any): string[] {
  const emps = peekPolicy()?.employees || [];
  return ((props[PROPS.assignee] || []) as string[]).map((id) => emps.find((e) => e.id === normId(id))?.display ?? id);
}

function summarize(p: any, props: any, full = false): any {
  const 작업내용: string = props[PROPS.content] || "";
  const 담당자 = assigneeNames(props);
  return {
    // 작업자: 외부 호환용 이름 — 값은 구형 select가 아니라 담당자 relation에서 파생(첫 담당자)
    id: p.id, url: p.url, 작업명: props[PROPS.title], 상태: props[PROPS.status], 우선순위: props[PROPS.priority], 작업자: 담당자[0] ?? null,
    담당자, 입력자: props[PROPS.inputter],
    프로젝트명: props[PROPS.projectName], 작업일: props[PROPS.workday], 완료일시: props[PROPS.doneAt], 아빠개입: props[PROPS.intervention],
    개입요청내용: props[PROPS.interventionReq], 확인필요: props[PROPS.needsCheck], in_trash: p.in_trash,
    ...(full
      ? { 작업내용: 작업내용, 결정사항: props[PROPS.decision], 관련파일: props[PROPS.files], GitCommit: props[PROPS.commits], 비고: props[PROPS.note], 의뢰자: props[PROPS.requester], 프로젝트: props[PROPS.project] }
      : { 최근기록: 작업내용.slice(-400) }),
  };
}

/** rich_text 속성 끝에 "[시각 · 호출자] text"를 덧붙인다 (기존 서식 보존) */
function appendRt(page: any, prop: string, text: string): any {
  const cur: any[] = page.properties[prop]?.rich_text || [];
  const add = rt((cur.length ? "\n" : "") + `${stamp()} ${text}`);
  let next = [...cur.map((r: any) => ({ type: "text", text: { content: r.plain_text, link: r.href ? { url: r.href } : null }, annotations: r.annotations })), ...add];
  if (next.length > 100) next = rt(plain(cur) + (cur.length ? "\n" : "") + `${stamp()} ${text}`).slice(-100);
  return { rich_text: next };
}

/** 이름(코드디, "01.아빠", "반짝이 (Gemini)" 등) → 직원·에이전트 레코드. 정확히 하나일 때만 */
async function findEmployee(name: string) {
  const p = await getPolicy();
  const n = name.trim();
  const hits = p.employees.filter((e) => e.name === n || e.display === n || e.display === displayName(n));
  return hits.length === 1 ? hits[0] : null;
}

const hasDadInstruction = (s?: string) => !!s && s.trim().length >= 8;

/** 우선순위: DB 선택지에 있어야 하고, 운영규칙상 아빠 전용 값은 아빠 지시 문구가 있어야 한다 */
async function checkPriority(value: string, dadInstruction?: string) {
  const p = await getPolicy();
  if (!p.priorities.includes(value)) throw new Error(`우선순위 '${value}'는 작업 원장 선택지에 없습니다: ${p.priorities.join("/")}`);
  if (p.dadOnlyPriorities.includes(value) && !hasDadInstruction(dadInstruction))
    throw new Error(`'${value}'는 운영규칙상 아빠 전용 우선순위입니다. 아빠가 명시적으로 지시한 경우에만 dad_instruction에 실제 지시 문구를 적어 지정하세요.`);
}

async function checkIntervention(iv?: { type: string; request?: string }) {
  if (!iv) return;
  const p = await getPolicy();
  if (!p.interventions.includes(iv.type)) throw new Error(`아빠 개입 값 '${iv.type}'는 선택지에 없습니다: ${p.interventions.join("/")}`);
  if (iv.type !== INTERVENTION_NONE && !(iv.request || "").trim()) throw new Error("아빠 개입이 필요하면 request(아빠가 무엇을 결정하거나 직접 해야 하는지)를 구체적으로 적어야 합니다.");
}

// ───────── 조회 ─────────
export async function taskSearch(a: { query?: string; status?: string | string[]; include_done_days?: number; project?: string; worker?: string; limit?: number }) {
  // Notion 복합필터 중첩 한도(2단계)에 맞춰 "공통조건 AND 상태조건"을 분기마다 펼쳐서 OR로 묶는다
  await getPolicy();
  const common: any[] = [];
  if (a.query) common.push({ property: PROPS.title, title: { contains: a.query } });
  if (a.project) common.push({ property: PROPS.projectName, rich_text: { contains: a.project } });
  if (a.worker) {
    // 외부 인자는 사람·AI 이름 그대로, 내부에서 직원·에이전트 relation id로 바꿔 「담당자」 relation으로 검색
    const emp = await findEmployee(a.worker);
    if (!emp) throw new Error(`직원·에이전트 DB에서 '${a.worker}'를 정확히 하나로 찾지 못했습니다. 정확한 이름: ${(await getPolicy()).employees.map((e) => e.display).join(", ")}`);
    common.push({ property: PROPS.assignee, relation: { contains: emp.id } });
  }
  const branches: any[][] = [];
  const st = a.status ? (Array.isArray(a.status) ? a.status : [a.status]) : null;
  if (st) for (const s of st) branches.push([{ property: PROPS.status, select: { equals: s } }]);
  else {
    branches.push([{ property: PROPS.status, select: { does_not_equal: STATUS_NAMES.done } }]); // 미완료(빈 값 포함)
    if (a.include_done_days) {
      const since = new Date(Date.now() - a.include_done_days * 86400000).toISOString().slice(0, 10);
      branches.push([{ property: PROPS.status, select: { equals: STATUS_NAMES.done } }, { property: PROPS.doneAt, date: { on_or_after: since } }]);
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
async function findProject(name: string): Promise<{ id: string | null; suggestions: string[] }> {
  const rows = await paginate("POST", `/data_sources/${IDS.projectDs}/query`, {}, 300);
  const n = name.trim().toLowerCase();
  const hit = rows.find((p: any) => titleOf(p).trim().toLowerCase() === n);
  const words = n.split(/[\s\-_/]+/).filter((w) => w.length >= 3);
  const suggestions = rows.map((p: any) => titleOf(p).trim())
    .filter((t: string) => t && (t.toLowerCase().includes(n) || n.includes(t.toLowerCase()) || words.some((w) => t.toLowerCase().includes(w))))
    .slice(0, 8);
  return { id: hit ? normId(hit.id) : null, suggestions };
}

const tokens = (s: string) => s.replace(/\[[^\]]*\]/g, " ").split(/[\s,·/()\-—:]+/).filter((w) => w.length >= 2);

export async function taskCreate(a: {
  project: string; title: string; content: string; status?: string; priority?: string; dad_instruction?: string;
  worker?: string; requester?: string; distinct_from?: { ids: string[]; reason: string }; extra?: Record<string, any>; test_object?: boolean;
}) {
  const p = await getPolicy();
  const status = a.status || STATUS_NAMES.todo;
  if (!p.statuses.includes(status)) throw new Error(`상태 '${status}'는 작업 원장 선택지에 없습니다: ${p.statuses.join("/")}`);
  if ([STATUS_NAMES.done, STATUS_NAMES.waiting, STATUS_NAMES.hold].includes(status)) throw new Error(`새 작업을 '${status}'로 만들 수 없습니다. 만든 뒤 task_finish(종료 게이트)로 바꾸세요.`);
  const priority = a.priority || (p.priorities.includes("중") ? "중" : undefined);
  if (priority) await checkPriority(priority, a.dad_instruction);
  if (a.extra && (PROPS.status in a.extra || PROPS.doneAt in a.extra || PROPS.inputter in a.extra)) throw new Error("extra로 상태·완료일시·입력자를 지정할 수 없습니다.");

  // 프로젝트: 이름이 정확히 같은 기존 프로젝트가 없으면 만들지 않는다(조용한 무연결 생성 금지, 새 프로젝트는 아빠 승인)
  const proj = await findProject(a.project);
  if (!proj.id) return {
    created: false,
    reason: `프로젝트 원장에 '${a.project}'와 이름이 정확히 같은 프로젝트가 없어 작업을 만들지 않았습니다. 기존 프로젝트 이름을 정확히 쓰거나, 공통·미분류 작업이면 운영규칙에 따라 master-project를 쓰세요. 새 프로젝트 등록은 아빠 승인이 필요합니다(자동 생성하지 않음).`,
    project_suggestions: proj.suggestions,
  };

  let title = a.title.trim();
  if (p.projectPrefix && !title.startsWith(`[${a.project}]`)) title = `[${a.project}] ${title}`;
  if (a.test_object && !title.startsWith(TEST_PREFIX.trim())) title = TEST_PREFIX + title;

  // 기존 작업 먼저 검색: 미완료 전체 + 최근 7일 완료, 제목 키워드 겹침으로 후보 판정
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

  // 사람·AI 기록: 입력자 = 실제 호출자(인자로 바꿀 수 없음), 담당자 = 직원·에이전트 relation(정확한 이름)
  const notes: string[] = [];
  const caller = currentCaller();
  const workerName = (a.worker || caller || "").trim();
  if (!workerName) throw new Error("작업자를 알 수 없습니다. 호출자 정보가 없으면 worker에 직원·에이전트 이름을 적으세요.");
  const emp = await findEmployee(workerName);
  if (!emp) throw new Error(`직원·에이전트 DB에서 '${workerName}'를 정확히 하나로 찾지 못했습니다. 정확한 이름: ${p.employees.map((e) => e.display).join(", ")}`);
  const s = await schema();
  const vals: any = { [PROPS.title]: title, [PROPS.status]: status, [PROPS.projectName]: a.project, [PROPS.workday]: await currentWorkday(), [PROPS.project]: [proj.id] };
  if (priority) vals[PROPS.priority] = priority;
  if (s[PROPS.assignee]) vals[PROPS.assignee] = [emp.id]; else notes.push(`'${PROPS.assignee}' relation 속성이 없어 담당자를 relation으로 남기지 못함`);
  if (!caller) notes.push("호출자를 확인할 수 없어 입력자를 비워 둠(추정하지 않음)");
  else if (p.inputterOptions.includes(caller)) vals[PROPS.inputter] = caller;
  else notes.push(`입력자(select) 선택지에 '${caller}'가 없어 비워 둠 — 작업내용 기록 머리표에 호출자 표시`);
  if (a.requester) { if (p.requesterOptions.includes(a.requester)) vals[PROPS.requester] = a.requester; else notes.push(`의뢰자 선택지에 '${a.requester}'가 없어 비워 둠`); }
  Object.assign(vals, a.extra || {});
  const props = buildProps(s, vals);
  props[PROPS.content] = { rich_text: rt(`${stamp()} ${a.content}${a.dad_instruction ? `\n(아빠 지시: ${a.dad_instruction})` : ""}`) };
  const page = await api("POST", "/pages", { parent: { type: "data_source_id", data_source_id: IDS.taskDs }, properties: props });
  markCreated(page.id, "page", title, !!a.test_object);
  audit({ tool: "task_create", id: page.id, title, caller, distinct_from: a.distinct_from, dad_instruction: a.dad_instruction });
  const re = await readTask(page.id);
  const linked = (re.props[PROPS.project] || []).map(normId).includes(proj.id);
  const assigned = !s[PROPS.assignee] || (re.props[PROPS.assignee] || []).map(normId).includes(emp.id);
  return {
    created: true, project_linked: linked, assignee: emp.name, inputter: vals[PROPS.inputter] ?? null, notes,
    verified: re.props[PROPS.title] === title && re.props[PROPS.status] === status && linked && assigned, task: summarize(re.page, re.props),
  };
}

// ───────── 시작 ─────────
export async function taskStart(a: { id: string; note: string; worker?: string; reopen_completed?: boolean }) {
  const { page, props } = await readTask(a.id);
  if (page.in_trash) throw new Error("휴지통에 있는 작업입니다.");
  if (props[PROPS.status] === STATUS_NAMES.done && !a.reopen_completed) throw new Error("이미 완료된 작업입니다. 다시 열려면 reopen_completed=true와 이유(note)를 주세요. 별개 후속 작업이면 task_create로 등록하세요.");
  const before = summarize(page, props, true);
  const body: any = { properties: { [PROPS.status]: { select: { name: STATUS_NAMES.doing } }, [PROPS.content]: appendRt(page, PROPS.content, `작업 시작${props[PROPS.status] === STATUS_NAMES.done ? "(재개)" : ""}: ${a.note}`) } };
  if (a.worker) {
    const emp = await findEmployee(a.worker);
    if (!emp) throw new Error(`직원·에이전트 DB에서 '${a.worker}'를 정확히 하나로 찾지 못했습니다.`);
    if (page.properties[PROPS.assignee]) body.properties[PROPS.assignee] = { relation: [{ id: emp.id }] };
    else throw new Error(`'${PROPS.assignee}' relation 속성이 없어 담당자를 바꿀 수 없습니다.`);
  }
  await api("PATCH", `/pages/${page.id}`, body);
  audit({ tool: "task_start", id: page.id, from: props[PROPS.status], caller: currentCaller() });
  const after = await readTask(page.id);
  const ok = after.props[PROPS.status] === STATUS_NAMES.doing;
  return {
    verified: ok, status_before: props[PROPS.status], status_after: after.props[PROPS.status],
    prior_record: { 결정사항: before.결정사항, 관련파일: before.관련파일, GitCommit: before.GitCommit, 최근기록: (before.작업내용 || "").slice(-1500), 아빠개입: before.아빠개입, 개입요청내용: before.개입요청내용 },
    reminder: "진행 중 기록은 task_update, 끝낼 때는 task_finish(종료 게이트). 절차의 정본은 운영규칙 「작업 원장 사용 절차」(rules_get).",
  };
}

// ───────── 진행 기록 ─────────
export async function taskUpdate(a: {
  id: string; progress?: string; decision?: string; files?: string; commits?: string; note?: string; priority?: string; dad_instruction?: string;
  intervention?: { type: string; request?: string };
}) {
  const { page, props } = await readTask(a.id);
  const pol = await getPolicy();
  const p: any = {};
  let progress = a.progress;
  if (a.priority) {
    await checkPriority(a.priority, a.dad_instruction);
    if (pol.dadOnlyPriorities.includes(props[PROPS.priority]) && !hasDadInstruction(a.dad_instruction))
      throw new Error(`현재 우선순위 '${props[PROPS.priority]}'는 아빠가 지정한 값이라 아빠 지시(dad_instruction) 없이 바꾸지 않습니다.`);
    p[PROPS.priority] = { select: { name: a.priority } };
    if (a.dad_instruction) progress = `${progress ? progress + "\n" : ""}우선순위 ${props[PROPS.priority] ?? "-"} → ${a.priority} (아빠 지시: ${a.dad_instruction})`;
  }
  if (progress) p[PROPS.content] = appendRt(page, PROPS.content, progress);
  if (a.decision) p[PROPS.decision] = appendRt(page, PROPS.decision, a.decision);
  if (a.files) p[PROPS.files] = appendRt(page, PROPS.files, a.files);
  if (a.commits) p[PROPS.commits] = appendRt(page, PROPS.commits, a.commits);
  if (a.note) p[PROPS.note] = appendRt(page, PROPS.note, a.note);
  if (a.intervention) {
    await checkIntervention(a.intervention);
    p[PROPS.intervention] = { select: { name: a.intervention.type } };
    p[PROPS.interventionReq] = { rich_text: a.intervention.type === INTERVENTION_NONE ? [] : rt(a.intervention.request!) };
  }
  if (!Object.keys(p).length) throw new Error("기록할 내용이 없습니다.");
  await api("PATCH", `/pages/${page.id}`, { properties: p });
  audit({ tool: "task_update", id: page.id, keys: Object.keys(p), caller: currentCaller(), dad_instruction: a.dad_instruction });
  const after = await readTask(page.id);
  const problems: string[] = [];
  if (progress && !(after.props[PROPS.content] || "").includes(progress.slice(0, 50))) problems.push("작업내용 미반영");
  if (a.intervention && after.props[PROPS.intervention] !== a.intervention.type) problems.push("아빠 개입 미반영");
  if (a.priority && after.props[PROPS.priority] !== a.priority) problems.push("우선순위 미반영");
  return { verified: problems.length === 0, problems, status: after.props[PROPS.status], note: "상태 변경은 task_finish로 합니다." };
}

// ───────── 종료 게이트 (안전장치: 검증 없는 완료·미해결 완료 금지, 재조회 검증) ─────────
export async function taskFinish(a: {
  id: string; outcome: string; result: string; verification?: string; unresolved?: string;
  next_steps?: string; waiting_for?: string; hold_reason?: string; files?: string; commits?: string;
  needs_dad_confirmation?: boolean; dad_confirmed?: string; intervention?: { type: string; request?: string };
}) {
  const { page, props } = await readTask(a.id);
  const pol = await getPolicy();
  const S = STATUS_NAMES;
  const before = props[PROPS.status];
  const errs: string[] = [];
  const warnings: string[] = [];
  if (!pol.statuses.includes(a.outcome)) errs.push(`outcome '${a.outcome}'는 작업 원장 상태 선택지에 없음: ${pol.statuses.join("/")}`);
  if (!a.result?.trim()) errs.push("result(실제 결과)가 비어 있음");
  if (a.outcome === S.done) {
    if (!a.verification?.trim() || a.verification.trim().length < 10) errs.push("완료하려면 verification(실제 검증 결과)을 구체적으로 적어야 함 — 조사·코드 작성·보고만으로는 완료 불가");
    if (a.needs_dad_confirmation && !a.dad_confirmed?.trim()) errs.push("아빠 확인이 성공조건인 작업은 아빠 확인 전 완료 불가 → 진행 상태 유지 + needs_dad_confirmation=true로 '아빠 확인대기'를 기록하세요");
    if (a.unresolved?.trim()) errs.push("미해결(unresolved)이 남아 있는데 완료로 닫으려 함 — 별개 후속이면 따로 등록하고 unresolved를 비우세요");
  } else if (!(a.next_steps?.trim() || a.waiting_for?.trim() || a.hold_reason?.trim())) {
    errs.push("완료가 아니면 다음 단계(next_steps)·기다리는 외부 조건(waiting_for)·중단 이유(hold_reason) 중 하나는 적어야 함 — 운영규칙 「작업 원장 사용 절차」");
  }
  if (a.outcome === S.waiting && !a.waiting_for?.trim()) errs.push("대기는 무엇을 기다리는지(waiting_for) 필수 — 운영규칙 「상태 의미」");
  if (a.outcome === S.hold && !a.hold_reason?.trim()) errs.push("보류는 이유(hold_reason) 필수 — 운영규칙 「상태 의미」");
  // 아래 두 가지는 운영규칙 해석이라 막지 않고 경고만 한다(정본은 운영규칙)
  if (a.outcome === S.waiting && a.waiting_for && /다음\s*(지시|작업|일)|지시를?\s*기다/.test(a.waiting_for)) warnings.push("'다음 지시를 기다림'은 운영규칙상 대기가 아니라 미착수일 수 있습니다 — 확인하세요.");
  if (a.outcome === S.hold && a.hold_reason && /아빠\s*(부재|없|외출)|장비|장소/.test(a.hold_reason)) warnings.push("아빠 부재·장소·장비 문제는 운영규칙상 보류가 아니라 아빠 개입 속성일 수 있습니다 — 확인하세요.");
  if (a.intervention) { try { await checkIntervention(a.intervention); } catch (e: any) { errs.push(e.message); } }
  if (errs.length) return { finished: false, gate: "rejected", errors: errs, warnings, status_unchanged: before };

  const lines = [`작업 종료 처리(${before} → ${a.outcome}${a.needs_dad_confirmation && a.outcome !== S.done ? ", 아빠 확인대기" : ""})`, `결과: ${a.result}`];
  if (a.verification) lines.push(`검증: ${a.verification}`);
  if (a.unresolved) lines.push(`미해결: ${a.unresolved}`);
  if (a.next_steps) lines.push(`다음 단계: ${a.next_steps}`);
  if (a.waiting_for) lines.push(`대기 사유(외부 조건): ${a.waiting_for}`);
  if (a.hold_reason) lines.push(`보류 사유: ${a.hold_reason}`);
  if (a.dad_confirmed) lines.push(`아빠 확인: ${a.dad_confirmed}`);
  const p: any = { [PROPS.status]: { select: { name: a.outcome } }, [PROPS.content]: appendRt(page, PROPS.content, lines.join("\n")) };
  if (a.files) p[PROPS.files] = appendRt(page, PROPS.files, a.files);
  if (a.commits) p[PROPS.commits] = appendRt(page, PROPS.commits, a.commits);
  if (a.outcome === S.done) {
    p[PROPS.doneAt] = { date: { start: new Date().toISOString() } };
    p[PROPS.intervention] = { select: { name: INTERVENTION_NONE } };
    p[PROPS.interventionReq] = { rich_text: [] };
    p[PROPS.needsCheck] = { checkbox: false };
  } else {
    if (props[PROPS.doneAt]) p[PROPS.doneAt] = { date: null };
    if (a.needs_dad_confirmation !== undefined) p[PROPS.needsCheck] = { checkbox: !!a.needs_dad_confirmation };
    if (a.intervention) {
      p[PROPS.intervention] = { select: { name: a.intervention.type } };
      p[PROPS.interventionReq] = { rich_text: a.intervention.type === INTERVENTION_NONE ? [] : rt(a.intervention.request!) };
    }
  }
  await api("PATCH", `/pages/${page.id}`, { properties: p });
  audit({ tool: "task_finish", id: page.id, from: before, to: a.outcome, caller: currentCaller() });

  // 재조회 → 실제 상태와 원장 일치 검증
  const re = await readTask(page.id);
  const checks: any[] = [
    { check: "상태", ok: re.props[PROPS.status] === a.outcome, actual: re.props[PROPS.status] },
    { check: "종료기록", ok: (re.props[PROPS.content] || "").includes(`결과: ${a.result}`.slice(0, 60)) },
  ];
  if (a.outcome === S.done) {
    checks.push({ check: "완료일시", ok: !!re.props[PROPS.doneAt], actual: re.props[PROPS.doneAt] });
    checks.push({ check: "아빠 개입=없음", ok: re.props[PROPS.intervention] === INTERVENTION_NONE || re.props[PROPS.intervention] == null });
  } else checks.push({ check: "완료일시 비어 있음", ok: !re.props[PROPS.doneAt], actual: re.props[PROPS.doneAt] });
  if (a.needs_dad_confirmation !== undefined && a.outcome !== S.done) checks.push({ check: "확인필요", ok: re.props[PROPS.needsCheck] === !!a.needs_dad_confirmation });
  return { finished: true, verified: checks.every((c) => c.ok), checks, warnings, task: summarize(re.page, re.props) };
}

// ───────── 운영규칙 ─────────
// 문서 목록의 정본은 운영규칙의 「공용 규칙 문서 목록」 표(policy.ts). 짧은 이름은 표의 제목 일부로 찾는다.
const SHORT: Record<string, string> = { rules: "운영규칙", exec: "실행·종료", identity: "정체성", dev: "개발" };
async function ruleId(doc?: string): Promise<string> {
  const ids = await ruleDocIds();
  const p = await getPolicy();
  const q = (SHORT[(doc || "").trim()] || doc || "").trim();
  if (!q || q === "운영규칙" || q === "woo's 메모리허브 운영규칙") return normId(IDS.rules);
  try { const n = normId(q); if (ids.has(n)) return n; } catch {}
  const hits = p.ruleDocs.filter((d) => d.title.includes(q));
  if (hits.length === 1) return hits[0].id;
  throw new Error(`운영규칙 문서를 ${hits.length ? "하나로 특정하지 못했습니다" : "찾지 못했습니다"}: ${doc}. 「공용 규칙 문서 목록」: ${p.ruleDocs.map((d) => d.title).join(" / ")}`);
}

export async function rulesGet(a: { doc?: string; section?: string }) {
  const id = await ruleId(a.doc);
  const p = await api("GET", `/pages/${id}`);
  let md = await blocksToMd(id, 0, 3, { n: 0, max: 3000 });
  if (a.section) {
    const parts = md.split(/\n(?=#{1,3} )/);
    const hit = parts.filter((s) => s.split("\n")[0].includes(a.section!));
    md = hit.length ? hit.join("\n") : `(섹션 "${a.section}" 없음)`;
  }
  return { id, title: titleOf(p), last_edited_time: p.last_edited_time, available_docs: (await getPolicy()).ruleDocs.map((d) => d.title), markdown: md };
}

export async function rulesUpdate(a: { doc?: string; dad_instruction: string; mode: "append_section" | "replace_text"; markdown?: string; old_text?: string; new_text?: string }) {
  if (!hasDadInstruction(a.dad_instruction)) throw new Error("운영규칙 변경은 아빠의 명시적 지시가 있을 때만 합니다. dad_instruction에 아빠의 실제 지시 문구를 그대로 적으세요.");
  const id = await ruleId(a.doc);
  const res = a.mode === "append_section"
    ? await writeContent({ id, mode: "append", markdown: a.markdown }, true)
    : await writeContent({ id, mode: "replace_text", old_text: a.old_text, new_text: a.new_text }, true);
  audit({ tool: "rules_update", id, mode: a.mode, caller: currentCaller(), dad_instruction: a.dad_instruction.slice(0, 300) });
  await getPolicy(true); // 규칙이 바뀌었으니 정책 캐시 갱신
  return res;
}

// ───────── 날짜별 작업일지 ─────────
// 작업일 기준 시각은 「초롱이 세팅」에서 읽는다(policy.ts). 제목 형식·위치는 구조 설정.
const WORKLOG_TITLE = process.env.WOOS_WORKLOG_TITLE || "{y}년 {m}월 {d}일 작업일지";
function worklogTitle(date: string) {
  const m = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error("date는 YYYY-MM-DD");
  return WORKLOG_TITLE.replace("{y}", String(Number(m[1]))).replace("{m}", String(Number(m[2]))).replace("{d}", String(Number(m[3])));
}
async function findWorklog(date: string): Promise<string | null> {
  const t = worklogTitle(date);
  for (const b of await paginate("GET", `/blocks/${IDS.worklogRoot}/children`, {}, 3000))
    if (b.type === "child_page" && b.child_page.title.trim() === t) return b.id;
  return null;
}
export async function worklogGet(a: { date?: string }) {
  const date = a.date || (await currentWorkday());
  const id = await findWorklog(date);
  if (!id) return { exists: false, date, title: worklogTitle(date) };
  return { exists: true, date, id, title: worklogTitle(date), markdown: await blocksToMd(id, 0, 3) };
}
export async function worklogWrite(a: { date?: string; markdown: string; create_if_missing?: boolean; test_object?: boolean }) {
  const date = a.date || (await currentWorkday());
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
  audit({ tool: "worklog_write", id, date, created, blocks: ids.length, caller: currentCaller() });
  const md = await blocksToMd(id, 0, 2);
  const probe = a.markdown.split("\n").map((l) => l.replace(/^[#>\-*\d.\s]+/, "").replace(/\*\*|`/g, "").trim()).find((l) => l.length > 3) || "";
  return { id, date, created, appended_blocks: ids.length, verified: md.includes(probe.slice(0, 40)) };
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
  audit({ tool: "employee_update", id, keys: Object.keys(a.properties), caller: currentCaller() });
  const after = await simplifyProps(await api("GET", `/pages/${id}`));
  const mism = Object.entries(a.properties).filter(([k, v]) => !sameVal(after[k], v)).map(([k]) => k);
  await getPolicy(true); // 직원 이름이 바뀌었을 수 있음
  return { verified: mism.length === 0, mismatches: mism, employee: after };
}

export { resolve };
