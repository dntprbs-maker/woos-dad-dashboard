// 공용 작업관리 API의 인증·응답·로깅 도우미
//
// 보안 원칙
// - 비밀값(NOTION_TOKEN, TASKS_API_KEY)은 어떤 경로로도 로그·응답에 싣지 않는다.
// - 키 비교는 해시 후 timingSafeEqual로 한다. 길이 차이로 정보가 새지 않게.
// - 인증이 필요한 응답은 공유 캐시에 남기지 않는다.

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * TASKS_API_KEY="secret" 또는 "chatgpt:secret1,claude:secret2" 를 파싱한다.
 * TASKS_API_KEY_HERMES는 TASKS_API_KEY를 덮어쓰지 않고 그 뒤에 이어 붙이는
 * 별도 변수다 — 기존 TASKS_API_KEY는 Vercel에서 Secret(write-only)이라 값을
 * 다시 읽어 라벨을 추가할 수 없어서, 해리 전용 키를 여기 새로 추가했다.
 */
function configuredKeys() {
  const raw = [process.env.TASKS_API_KEY, process.env.TASKS_API_KEY_HERMES]
    .filter(Boolean)
    .join(",");
  const entries = [];
  for (const part of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx > 0 && LABEL_RE.test(part.slice(0, idx))) {
      entries.push({ label: part.slice(0, idx), secret: part.slice(idx + 1) });
    } else {
      entries.push({ label: "default", secret: part });
    }
  }
  return entries.filter(e => e.secret.length >= 16);
}

const digest = s => createHash("sha256").update(String(s)).digest();

function sameSecret(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

function presentedKey(req) {
  const auth = req.headers.authorization || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

/**
 * @returns {{ok:true,label:string} | {ok:false,status:number,code:string,error:string}}
 */
export function authenticate(req) {
  const keys = configuredKeys();
  if (!keys.length) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      error: "TASKS_API_KEY가 설정되지 않았습니다 (16자 이상 필요)"
    };
  }
  const given = presentedKey(req);
  if (!given) {
    return {
      ok: false,
      status: 401,
      code: "missing_api_key",
      error: "Authorization: Bearer <key> 또는 x-api-key 헤더가 필요합니다"
    };
  }
  // 일치하는 키가 있어도 전부 비교해 타이밍 차이를 줄인다.
  let matched = null;
  for (const k of keys) {
    if (sameSecret(given, k.secret)) matched = matched || k.label;
  }
  if (!matched) {
    return { ok: false, status: 401, code: "invalid_api_key", error: "API 키가 올바르지 않습니다" };
  }
  return { ok: true, label: matched };
}

export function newRequestId() {
  return randomUUID();
}

/** 비밀값이 절대 섞이지 않도록 허용된 필드만 남겨 로그를 찍는다. */
export function log(fields) {
  const safe = {
    rid: fields.rid,
    method: fields.method,
    route: fields.route,
    status: fields.status,
    ms: fields.ms,
    key: fields.key,          // 라벨만. 비밀값 아님
    code: fields.code,
    notion_request_id: fields.notionRequestId
  };
  for (const k of Object.keys(safe)) if (safe[k] === undefined) delete safe[k];
  console.log(JSON.stringify(safe));
}

export function send(res, status, payload, rid) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (rid) res.setHeader("X-Request-Id", rid);
  res.status(status).json(payload);
}

export function fail(res, status, code, error, rid, extra) {
  send(res, status, { ok: false, code, error, ...(extra || {}) }, rid);
}

/** CORS는 기본 비활성. 브라우저에서 부를 일이 있을 때만 환경변수로 연다. */
export function applyCors(req, res) {
  const allowed = (process.env.TASKS_API_ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin || !allowed.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

const MAX_BODY = 200 * 1024; // 200KB

/** Vercel이 파싱해 주지 않는 경우까지 감안해 직접 읽는다. */
export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (!req.body) return {};
    try { return JSON.parse(req.body); } catch { throw new Error("본문이 올바른 JSON이 아닙니다"); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("요청 본문이 너무 큽니다 (최대 200KB)");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("본문이 올바른 JSON이 아닙니다"); }
}
