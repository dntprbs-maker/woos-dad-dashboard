// WOO'S 메모리허브 MCP 원격 경로 (초롱이 등 원격 AI용, Streamable HTTP · stateless)
//
//   POST /api/memoryhub/<MEMORYHUB_MCP_KEY>   또는  Authorization: Bearer <MEMORYHUB_MCP_KEY>
//
// 도구 정의·실행 로직은 이 저장소의 mcp-memoryhub/src/tools.ts를 번들한 _lib/memoryhub.bundle.mjs를 쓴다.
// 번들 갱신: mcp-memoryhub 폴더에서 npm run release (빌드 + 이 번들 재생성).
// 키가 설정되지 않았으면 모든 요청을 거부한다. 키마다 호출자 라벨이 있어 입력자 기록에 쓰인다.
import { timingSafeEqual } from "node:crypto";
import { handleMcp } from "./_lib/memoryhub.bundle.mjs";

function keyOf(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("mhkey");
  if (q) return q;
  return url.pathname.replace(/^\/api\/memoryhub\/?/, "").split("/").filter(Boolean).pop() || "";
}
// 키 → 호출자 라벨. MEMORYHUB_MCP_KEYS="초롱이:<키>,별이:<키>" (라벨별 키)
// + 하위호환: MEMORYHUB_MCP_KEY(+ MEMORYHUB_MCP_KEY_OWNER=그 키를 쓰는 AI 이름)
function keyTable() {
  const out = [];
  for (const part of (process.env.MEMORYHUB_MCP_KEYS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i > 0) out.push({ label: part.slice(0, i).trim(), key: part.slice(i + 1).trim() });
  }
  if (process.env.MEMORYHUB_MCP_KEY) out.push({ label: (process.env.MEMORYHUB_MCP_KEY_OWNER || "").trim() || null, key: process.env.MEMORYHUB_MCP_KEY });
  return out.filter((x) => x.key && x.key.length >= 32);
}
function authOf(given) {
  if (!given) return null;
  const a = Buffer.from(given);
  for (const k of keyTable()) {
    const b = Buffer.from(k.key);
    if (a.length === b.length && timingSafeEqual(a, b)) return { caller: k.label };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const auth = authOf(keyOf(req));
  if (!auth) {
    res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "인증 실패" } });
    return;
  }
  if (req.method === "GET") { res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "POST만 받습니다" } }); return; }
  if (req.method === "DELETE") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }
  try {
    await handleMcp(req, res, req.body, auth.caller);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "서버 오류" } });
  }
}
