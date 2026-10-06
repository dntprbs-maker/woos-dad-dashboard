// 운영정책 로더 — 바뀔 수 있는 업무정책은 코드에 박지 않고 Notion 원본(SSoT)에서 읽는다.
//
//   작업 원장 DB 스키마      → 상태·우선순위·아빠 개입·입력자/의뢰자 선택지(담당자는 직원·에이전트 relation만 사용)
//   「woo's 메모리허브 운영규칙」 → 공용 규칙 문서 목록(표), 아빠 전용 우선순위, 작업명 [프로젝트명] 규칙
//   「초롱이 세팅」           → 작업일 기준 시각(예: 09:00~다음 날 08:59)
//   「👥 직원·에이전트」 DB   → 실제 작업자 이름(담당자 relation 대상)
//
// 읽기 실패·문장 해석 실패 시에는 아래 DEFAULTS로 동작하고, 그 사실을 policy_get의 fallbacks에 남긴다.
// 결과는 WOOS_POLICY_TTL_SEC(기본 300초) 동안 캐시한다.
import { api, paginate, normId } from "./notion.js";
import { blocksToMd, titleOf } from "./format.js";
import { IDS } from "./core.js";

const DEFAULTS = {
  workdayStart: { h: 9, m: 0 },          // 초롱이 세팅 문장을 못 읽을 때만 사용
  dadOnlyPriorities: ["최상", "최하"],    // 운영규칙 문장을 못 읽을 때만 사용
  projectPrefix: true,
};
// 상태 의미(코드의 종료 게이트가 판단에 쓰는 이름). 이름이 바뀌면 환경변수로 맞춘다.
export const STATUS_NAMES = {
  done: process.env.WOOS_STATUS_DONE || "완료",
  doing: process.env.WOOS_STATUS_DOING || "진행중",
  waiting: process.env.WOOS_STATUS_WAITING || "대기",
  hold: process.env.WOOS_STATUS_HOLD || "보류",
  todo: process.env.WOOS_STATUS_TODO || "미착수",
};
export const INTERVENTION_NONE = process.env.WOOS_INTERVENTION_NONE || "없음";

export interface Policy {
  loaded_at: string;
  statuses: string[];
  priorities: string[];
  dadOnlyPriorities: string[];
  interventions: string[];
  inputterOptions: string[];
  requesterOptions: string[];
  ruleDocs: { title: string; id: string; targets: string }[];
  workdayStart: { h: number; m: number };
  projectPrefix: boolean;
  employees: { id: string; name: string; display: string; kind: string | null; status: string | null }[];
  sources: Record<string, string>;
  fallbacks: string[];
}

let cache: { at: number; p: Policy } | null = null;
/** 이미 로드된 정책(없으면 null) — 동기 코드에서 직원 id→이름 변환용 */
export const peekPolicy = (): Policy | null => cache?.p ?? null;
let inflight: Promise<Policy> | null = null;
const TTL = Number(process.env.WOOS_POLICY_TTL_SEC || 300) * 1000;

export async function getPolicy(force = false): Promise<Policy> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.p;
  if (inflight) return inflight;
  inflight = load().then((p) => { cache = { at: Date.now(), p }; return p; }).finally(() => { inflight = null; });
  return inflight;
}

const opts = (prop: any): string[] => (prop?.select?.options || prop?.multi_select?.options || prop?.status?.options || []).map((o: any) => o.name);

/** "01.아빠", "반짝이 (Gemini)" → "아빠", "반짝이" */
export function displayName(name: string): string {
  return name.replace(/^\s*\d+\.\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

async function load(): Promise<Policy> {
  const fallbacks: string[] = [];
  const sources: Record<string, string> = {};

  // 1) 작업 원장 스키마
  const ds = await api("GET", `/data_sources/${IDS.taskDs}`);
  const P = ds.properties;
  sources.task_schema = `작업 원장 데이터소스 ${IDS.taskDs}`;
  const statuses = opts(P[PROPS.status]);
  const priorities = opts(P[PROPS.priority]);
  const interventions = opts(P[PROPS.intervention]);

  // 2) 운영규칙 본문
  let rulesMd = "";
  try { rulesMd = await blocksToMd(IDS.rules, 0, 3, { n: 0, max: 3000 }); sources.rules = `운영규칙 ${IDS.rules}`; }
  catch (e: any) { fallbacks.push(`운영규칙 읽기 실패: ${e.message}`); }

  const ruleDocs = parseRuleDocs(rulesMd);
  if (!ruleDocs.length) fallbacks.push("「공용 규칙 문서 목록」 표를 찾지 못함 — 운영규칙 본문만 규칙 문서로 취급");

  let dadOnly = parseDadOnly(rulesMd, priorities);
  if (!dadOnly.length) { dadOnly = DEFAULTS.dadOnlyPriorities.filter((x) => priorities.includes(x)); fallbacks.push(`아빠 전용 우선순위 문장 해석 실패 — 기본값 ${dadOnly.join("/")}`); }

  let projectPrefix = /`\[프로젝트명\]\s*작업명`/.test(rulesMd);
  if (!rulesMd) { projectPrefix = DEFAULTS.projectPrefix; }
  else if (!projectPrefix) fallbacks.push("작업명 `[프로젝트명] 작업명` 규칙 문장을 찾지 못함 — 접두어를 붙이지 않음");

  // 3) 초롱이 세팅 — 작업일 기준
  let workdayStart = DEFAULTS.workdayStart;
  try {
    const md = await blocksToMd(IDS.chorong, 0, 2, { n: 0, max: 1500 });
    const m = md.match(/작업일은\s*(\d{1,2})\s*:\s*(\d{2})\s*[~∼〜-]\s*다음\s*날/);
    if (m) { workdayStart = { h: Number(m[1]), m: Number(m[2]) }; sources.workday = `초롱이 세팅 ${IDS.chorong}`; }
    else fallbacks.push(`초롱이 세팅에서 작업일 기준 문장을 찾지 못함 — 기본값 ${pad(DEFAULTS.workdayStart.h)}:${pad(DEFAULTS.workdayStart.m)}`);
  } catch (e: any) { fallbacks.push(`초롱이 세팅 읽기 실패(${e.message}) — 작업일 기본값 사용`); }

  // 4) 직원·에이전트
  const employees: Policy["employees"] = [];
  try {
    for (const p of await paginate("POST", `/data_sources/${IDS.employeeDs}/query`, {}, 500)) {
      const name = titleOf(p);
      employees.push({ id: normId(p.id), name, display: displayName(name), kind: p.properties?.["구분"]?.select?.name ?? null, status: p.properties?.["상태"]?.select?.name ?? null });
    }
    sources.employees = `직원·에이전트 ${IDS.employeeDs}`;
  } catch (e: any) { fallbacks.push(`직원·에이전트 읽기 실패: ${e.message}`); }

  return {
    loaded_at: new Date().toISOString(), statuses, priorities, dadOnlyPriorities: dadOnly, interventions,
    inputterOptions: opts(P[PROPS.inputter]), requesterOptions: opts(P[PROPS.requester]),
    ruleDocs, workdayStart, projectPrefix, employees, sources, fallbacks,
  };
}

// 작업 원장 속성명 매핑(구조값) — 이름이 바뀌면 환경변수로 맞춘다.
const env = (k: string, d: string) => process.env[k] || d;
export const PROPS = {
  title: env("WOOS_PROP_TITLE", "작업명"), status: env("WOOS_PROP_STATUS", "상태"), priority: env("WOOS_PROP_PRIORITY", "우선순위"),
  assignee: env("WOOS_PROP_ASSIGNEE", "담당자"), inputter: env("WOOS_PROP_INPUTTER", "입력자"),
  requester: env("WOOS_PROP_REQUESTER", "의뢰자"), projectName: env("WOOS_PROP_PROJECT_NAME", "프로젝트명"), project: env("WOOS_PROP_PROJECT", "프로젝트"),
  workday: env("WOOS_PROP_WORKDAY", "작업일"), doneAt: env("WOOS_PROP_DONE_AT", "완료일시"), intervention: env("WOOS_PROP_INTERVENTION", "아빠 개입"),
  interventionReq: env("WOOS_PROP_INTERVENTION_REQ", "개입 요청 내용"), needsCheck: env("WOOS_PROP_NEEDS_CHECK", "확인필요"),
  content: env("WOOS_PROP_CONTENT", "작업내용"), decision: env("WOOS_PROP_DECISION", "결정사항"), files: env("WOOS_PROP_FILES", "관련파일"),
  commits: env("WOOS_PROP_COMMITS", "Git Commit"), note: env("WOOS_PROP_NOTE", "비고"),
};

const pad = (n: number) => String(n).padStart(2, "0");

export function parseRuleDocs(md: string): { title: string; id: string; targets: string }[] {
  const i = md.indexOf("공용 규칙 문서 목록");
  if (i < 0) return [];
  const out: { title: string; id: string; targets: string }[] = [];
  for (const line of md.slice(i).split("\n").slice(1, 80)) {
    if (/^#{1,3}\s/.test(line) && out.length) break;
    if (!line.trim().startsWith("|")) { if (out.length && line.trim() === "") continue; continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const idCell = cells.find((c) => /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i.test(c));
    if (!idCell) continue;
    out.push({ title: cells[0], id: normId(idCell.match(/[0-9a-f-]{32,36}/i)![0]), targets: cells[2] || "" });
  }
  return out;
}

export function parseDadOnly(md: string, priorities: string[]): string[] {
  const found = new Set<string>();
  for (const line of md.split("\n")) {
    if (!/아빠\s*전용/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) if (priorities.includes(m[1].trim())) found.add(m[1].trim());
  }
  return [...found];
}

/** 작업일(YYYY-MM-DD): 기준 시각(KST) 이전이면 전날로 본다. 예: 기준 09:00 → 10/6 02:00은 10/5 */
export function workdayOf(date: Date, start: { h: number; m: number }): string {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minutes < start.h * 60 + start.m) kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

export async function currentWorkday(now = new Date()): Promise<string> {
  return workdayOf(now, (await getPolicy()).workdayStart);
}

/** 정책 요약(도구 policy_get 응답용) */
export async function policySummary(force = false) {
  const p = await getPolicy(force);
  return {
    loaded_at: p.loaded_at, sources: p.sources, fallbacks: p.fallbacks,
    statuses: p.statuses, priorities: p.priorities, dad_only_priorities: p.dadOnlyPriorities,
    ai_priorities: p.priorities.filter((x) => !p.dadOnlyPriorities.includes(x)), interventions: p.interventions,
    workday_start: `${pad(p.workdayStart.h)}:${pad(p.workdayStart.m)} (KST)`, project_prefix_rule: p.projectPrefix,
    rule_docs: p.ruleDocs, employees: p.employees.map((e) => ({ name: e.name, display: e.display, 구분: e.kind, 상태: e.status })),
    select_options: { 입력자: p.inputterOptions, 의뢰자: p.requesterOptions },
  };
}
