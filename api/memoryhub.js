// WOO'S 메모리허브 MCP 원격 경로 (초롱이 등 원격 AI용, Streamable HTTP · stateless)
//
//   POST /api/memoryhub/<MEMORYHUB_MCP_KEY>   또는  Authorization: Bearer <MEMORYHUB_MCP_KEY>
//
// 도구 정의·실행 로직은 woos-memoryhub-mcp 저장소(src/tools.ts)를 번들한 _lib/memoryhub.bundle.mjs를 쓴다.
// 번들 갱신: woos-memoryhub-mcp에서 npm run build 후 esbuild로 dist/http.js를 다시 번들한다.
// 키는 기존 TASKS_API_KEY와 별개이며, 키가 설정되지 않았으면 모든 요청을 거부한다.
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
function keyOk(given) {
  const want = process.env.MEMORYHUB_MCP_KEY || "";
  if (want.length < 32 || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!keyOk(keyOf(req))) {
    res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "인증 실패" } });
    return;
  }
  if (req.method === "GET") { res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "POST만 받습니다" } }); return; }
  if (req.method === "DELETE") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }
  try {
    await handleMcp(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "서버 오류" } });
  }
}
