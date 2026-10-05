// 공통: 객체 판별, 보호 대상, 감사 로그, 휴지통 안전장치
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { api, normId, NotionError } from "./notion.js";
import { titleOf, simplifyProps } from "./format.js";

// ───────── WOO'S 고정 ID (환경변수로 덮어쓰기 가능) ─────────
const env = (k: string, d: string) => process.env[k] || d;
export const IDS = {
  rules: env("WOOS_RULES_PAGE_ID", "3c92d174-b03c-81c3-bff4-c95cb9ef0585"),
  rulesExec: env("WOOS_RULES_EXEC_PAGE_ID", "3de2d174-b03c-817e-8ec5-e8280bc8345f"),
  rulesIdentity: env("WOOS_RULES_IDENTITY_PAGE_ID", "3d32d174-b03c-8159-84d9-c672a8a417f0"),
  rulesDev: env("WOOS_RULES_DEV_PAGE_ID", "3e62d174-b03c-81db-93bf-d8488b563a77"),
  taskDb: env("WOOS_TASK_DB_ID", "3c82d174-b03c-81fd-8802-e661400a4f53"),
  taskDs: env("WOOS_TASK_DS_ID", "8ba2d174-b03c-8369-b0a2-07b234b93430"),
  projectDs: env("WOOS_PROJECT_DS_ID", "549c38bf-1bf1-4e9f-8fd6-e0c9b6ff0220"),
  projectDb: env("WOOS_PROJECT_DB_ID", "c9f1ffd1-e981-489a-bd44-543a4b3e85de"),
  employeeDs: env("WOOS_EMPLOYEE_DS_ID", "3ad01af5-b966-48a4-95da-92b53a5c1c18"),
  employeeDb: env("WOOS_EMPLOYEE_DB_ID", "ef6dd886-413c-4de0-a38e-4ef4320fda54"),
  programDs: env("WOOS_PROGRAM_DS_ID", "1d72fe7f-de77-4c60-869e-4eabbb5783c9"),
  messengerDs: env("WOOS_MESSENGER_DS_ID", "ca0b5444-eaf9-4b75-b60d-a8b1426d0407"),
  messengerDb: env("WOOS_MESSENGER_DB_ID", "4b8b5117-25eb-4825-a5a9-8cf7ecdc578e"),
  worklogRoot: env("WOOS_WORKLOG_PAGE_ID", "3d92d174-b03c-8176-a25d-f400af461614"),
  hq: env("WOOS_HQ_PAGE_ID", "3b42d174-b03c-81d5-a10c-ceb740c4f728"),
  chorong: env("WOOS_CHORONG_PAGE_ID", "3cf2d174-b03c-81ea-a810-c8d8f18668d5"),
};

/** 보호 객체(구조 설정값) — 휴지통 불가·이동은 아빠 지시 필요·스키마는 추가만. 운영규칙 문서는 safety.ts가 운영규칙 표에서 더한다 */
export const PROTECTED = new Set(
  [IDS.rules, IDS.rulesExec, IDS.rulesIdentity, IDS.rulesDev, IDS.taskDb, IDS.taskDs, IDS.projectDs, IDS.projectDb,
   IDS.employeeDs, IDS.employeeDb, IDS.programDs, IDS.messengerDs, IDS.messengerDb, IDS.worklogRoot, IDS.hq, IDS.chorong,
   ...(process.env.WOOS_PROTECTED_IDS || "").split(",").filter(Boolean)].map((x) => normId(x)),
);

// ───────── 상태 디렉터리·감사 로그 ─────────
export const STATE_DIR = process.env.WOOS_MCP_STATE_DIR || (process.env.VERCEL ? "/tmp/woos-memoryhub-mcp" : join(process.env.LOCALAPPDATA || process.env.HOME || ".", "woos-memoryhub-mcp"));
mkdirSync(STATE_DIR, { recursive: true });
export function audit(entry: Record<string, any>) {
  try { appendFileSync(join(STATE_DIR, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}

// 이 MCP가 만든 객체 기록 (테스트 객체 정리 허용 판단용)
const CREATED_FILE = join(STATE_DIR, "created.json");
function loadCreated(): Record<string, any> { try { return JSON.parse(readFileSync(CREATED_FILE, "utf8")); } catch { return {}; } }
export function markCreated(id: string, kind: string, title: string, test: boolean) {
  const c = loadCreated();
  c[normId(id)] = { kind, title, test, at: new Date().toISOString() };
  try { writeFileSync(CREATED_FILE, JSON.stringify(c, null, 1)); } catch {}
}
export function createdInfo(id: string): any { return loadCreated()[normId(id)]; }

// ───────── 객체 판별 ─────────
export type Kind = "page" | "database" | "data_source" | "block";
export async function resolve(idOrUrl: string): Promise<{ kind: Kind; obj: any; id: string }> {
  const id = normId(idOrUrl);
  for (const [kind, path] of [["page", "/pages/"], ["data_source", "/data_sources/"], ["database", "/databases/"], ["block", "/blocks/"]] as const) {
    try {
      const obj = await api("GET", path + id);
      return { kind, obj, id };
    } catch (e: any) {
      if (!(e instanceof NotionError) || ![400, 404].includes(e.status)) throw e;
    }
  }
  throw new Error(`ID ${id}를 찾을 수 없습니다 (없음 또는 이 MCP 통합에 공유되지 않음).`);
}

export function parentOf(obj: any): { type: string; id: string | null } {
  const p = obj.parent || {};
  const t = p.type;
  return { type: t, id: t === "workspace" ? null : p[t] ?? null };
}

export async function describe(r: { kind: Kind; obj: any; id: string }, withProps = true) {
  const o = r.obj;
  const base: any = {
    kind: r.kind,
    id: r.id,
    title: titleOf(o),
    url: o.url,
    parent: parentOf(o),
    in_trash: o.in_trash ?? o.archived ?? false,
    last_edited_time: o.last_edited_time,
    protected: PROTECTED.has(r.id),
  };
  if (r.kind === "page" && withProps && o.parent?.type === "data_source_id") base.properties = await simplifyProps(o);
  if (r.kind === "database") base.data_sources = o.data_sources;
  if (r.kind === "data_source") base.database_parent = o.database_parent;
  if (r.kind === "block") base.block_type = o.type;
  return base;
}

/** database ID / data source ID / URL 무엇을 받아도 data source ID로 */
export async function toDataSource(idOrUrl: string): Promise<{ dsId: string; ds: any }> {
  const s = idOrUrl.trim();
  const id = normId(s.startsWith("collection://") ? s.slice(13) : s);
  try { const ds = await api("GET", `/data_sources/${id}`); return { dsId: id, ds }; } catch (e: any) {
    if (!(e instanceof NotionError) || ![400, 404].includes(e.status)) throw e;
  }
  const db = await api("GET", `/databases/${id}`);
  const first = db.data_sources?.[0]?.id;
  if (!first) throw new Error("이 데이터베이스에 data source가 없습니다.");
  if (db.data_sources.length > 1) {
    // 여러 개면 첫 번째를 쓰되 알려 준다
  }
  const ds = await api("GET", `/data_sources/${first}`);
  return { dsId: first, ds };
}

/** 블록이 속한 페이지 ID 찾기 (운영규칙 보호 판단용) */
export async function owningPage(blockId: string): Promise<string | null> {
  let cur = normId(blockId);
  for (let i = 0; i < 12; i++) {
    let b: any;
    try { b = await api("GET", `/blocks/${cur}`); } catch { return null; }
    if (b.type === "child_page") return cur;
    const p = b.parent;
    if (p.type === "page_id") return normId(p.page_id);
    if (p.type !== "block_id") return null;
    cur = p.block_id;
  }
  return null;
}


// ───────── 휴지통 승인 토큰 ─────────
interface Pending { token: string; created: number; items: { id: string; kind: Kind; title: string; last_edited_time: string }[] }
const PENDING_FILE = join(STATE_DIR, "trash-pending.json");
function loadPending(): Record<string, Pending> { try { return JSON.parse(readFileSync(PENDING_FILE, "utf8")); } catch { return {}; } }
function savePending(p: Record<string, Pending>) { writeFileSync(PENDING_FILE, JSON.stringify(p, null, 1)); }
export const TRASH_TTL_MS = 30 * 60 * 1000;
export const TRASH_MAX = 20;

// 서버리스(Vercel)는 호출 사이에 파일 상태가 유지되지 않으므로 서명 토큰(상태 없음)을 쓴다.
const SECRET = process.env.WOOS_TOKEN_SECRET;
const sign = (s: string) => createHmac("sha256", SECRET!).update(s).digest("base64url");
export function newPending(items: Pending["items"]): string {
  if (SECRET) {
    const payload = Buffer.from(JSON.stringify({ created: Date.now(), items })).toString("base64url");
    return `trash.${payload}.${sign(payload)}`;
  }
  const token = "trash-" + randomBytes(9).toString("hex");
  const all = loadPending();
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.created > TRASH_TTL_MS) delete all[k];
  all[token] = { token, created: Date.now(), items };
  savePending(all);
  return token;
}
export function takePending(token: string): Pending {
  if (SECRET && token.startsWith("trash.")) {
    const [, payload, sig] = token.split(".");
    const want = Buffer.from(sign(payload || "")), got = Buffer.from(sig || "");
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error("승인 토큰이 올바르지 않습니다. trash_prepare부터 다시 하세요.");
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Date.now() - p.created > TRASH_TTL_MS) throw new Error("승인 토큰이 만료됐습니다(30분). trash_prepare부터 다시 하세요.");
    return { token, ...p };
  }
  const all = loadPending();
  const p = all[token];
  if (!p) throw new Error("승인 토큰이 없거나 이미 사용됐습니다. trash_prepare부터 다시 하세요.");
  delete all[token];
  savePending(all);
  if (Date.now() - p.created > TRASH_TTL_MS) throw new Error("승인 토큰이 만료됐습니다(30분). trash_prepare부터 다시 하세요.");
  return p;
}
export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
export { existsSync };
