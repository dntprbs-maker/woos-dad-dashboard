// 공식 Notion REST API 얇은 클라이언트. 토큰은 환경변수/ .env 파일에서만 읽고 절대 출력하지 않는다.
import { readFileSync, existsSync } from "node:fs";

export const NOTION_VERSION = process.env.WOOS_NOTION_VERSION || "2025-09-03";
const BASE = "https://api.notion.com/v1";
const DEFAULT_ENV_FILE = "C:\\Users\\user\\projects\\woos-dad-dashboard\\.env";

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

let cachedToken: string | null = null;
export function token(): string {
  if (cachedToken) return cachedToken;
  const t =
    process.env.WOOS_NOTION_TOKEN ||
    process.env.NOTION_TOKEN ||
    readEnvFile(process.env.WOOS_NOTION_ENV_FILE || DEFAULT_ENV_FILE).NOTION_TOKEN;
  if (!t) throw new Error("Notion 토큰을 찾지 못했습니다 (WOOS_NOTION_TOKEN / NOTION_TOKEN / WOOS_NOTION_ENV_FILE).");
  cachedToken = t;
  return t;
}

export class NotionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`Notion ${status} ${code}: ${message}`);
  }
}

function redact(s: string): string {
  const t = cachedToken;
  return t ? s.split(t).join("***") : s;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 800 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
    if (!res.ok) throw new NotionError(res.status, json.code || "error", redact(String(json.message || text).slice(0, 500)));
    return json as T;
  }
}

/** 커서 페이지네이션을 따라가며 results를 모은다 */
export async function paginate(method: "GET" | "POST", path: string, body: any = {}, max = 1000): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    let res: any;
    if (method === "GET") {
      const sep = path.includes("?") ? "&" : "?";
      res = await api("GET", `${path}${sep}page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    } else {
      res = await api("POST", path, { ...body, page_size: Math.min(100, max - out.length), ...(cursor ? { start_cursor: cursor } : {}) });
    }
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && out.length < max);
  return out.slice(0, max);
}

/** URL·대시 없는 ID 등 어떤 형태든 UUID로 정규화 */
export function normId(input: string): string {
  const s = input.trim();
  const m = s.replace(/-/g, "").match(/([0-9a-f]{32})(?![0-9a-f])/i);
  if (!m) throw new Error(`Notion ID를 해석할 수 없습니다: ${input}`);
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
