// /api/mcp 와 완전히 같은 MCP 서버(도구 정의·실행 로직)를 그대로 재사용하는 별도 경로.
//
//   POST /api/mcp-v2/<키>    경로키 인증 (기존 /api/mcp 와 동일한 방식)
//
// OpenAI/ChatGPT가 이 서버(URL) 단위로 tools/list 응답을 캐시하고 있어 새
// 도구가 안 보이는 문제를 겪을 때, URL 자체를 바꿔 그 캐시를 우회해 보기
// 위한 테스트용 alias다. 실제 도구 실행은 api/mcp-server.js 의 handleRpc를
// 그대로 가져다 쓰므로 두 경로의 동작은 100% 동일하다.
//
// 기존 /api/mcp, 그 인증 방식, TOOLS 정의는 이 파일이 건드리지 않는다.

import { authenticate, newRequestId, readJson, log } from "./_lib/http.js";
import { NotionError } from "./_lib/notion.js";
import { ApiError } from "./_lib/ops.js";
import { handleRpc } from "./mcp-server.js";

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// 헤더를 못 넣는 클라이언트를 위해 경로 마지막 조각의 키도 인증에 쓴다.
// /api/mcp 의 withPathKey와 동일한 로직이되 프리픽스만 mcp-v2로 바꾼 것.
function withPathKey(req) {
  const url = new URL(req.url, "http://localhost");
  const fromRewrite = url.searchParams.get("mcpkey");
  const raw = fromRewrite !== null
    ? fromRewrite
    : url.pathname.replace(/^\/api\/mcp-v2\/?/, "");

  const key = raw.split("/").filter(Boolean).pop();
  if (!key || req.headers.authorization || req.headers["x-api-key"]) return req;

  return new Proxy(req, {
    get(target, prop) {
      if (prop === "headers") return { ...target.headers, authorization: "Bearer " + key };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}

export default async function handler(req, res) {
  const rid = newRequestId();
  const started = Date.now();

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (req.method === "GET") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "이 서버는 POST만 받습니다" } });
    return;
  }
  if (req.method === "DELETE") { res.status(204).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "POST만 받습니다" } });
    return;
  }

  const authed = withPathKey(req);
  const auth = authenticate(authed);
  if (!auth.ok) {
    log({ rid, method: "POST", route: "/api/mcp-v2", status: auth.status, code: auth.code, ms: Date.now() - started });
    res.status(auth.status).json(rpcError(null, -32001, auth.error));
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    res.status(400).json(rpcError(null, -32700, e.message));
    return;
  }

  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      log({
        rid, method: "POST", route: "/api/mcp-v2", status: out.length ? 200 : 202,
        ms: Date.now() - started, key: auth.label, code: "batch"
      });
      if (!out.length) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }

    const out = await handleRpc(body);
    log({
      rid, method: "POST", route: "/api/mcp-v2", status: out ? 200 : 202, code: body?.method,
      ms: Date.now() - started, key: auth.label
    });

    if (!out) { res.status(202).end(); return; }
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof ApiError || e instanceof NotionError) {
      // handleRpc가 이미 도구 오류를 도구 결과로 감싸므로 여기까지 올라오지 않는게
      // 정상이지만, 방어적으로 같은 방식으로 처리한다.
      console.error(JSON.stringify({ rid, scope: "mcp-v2", tool_error: e.message }));
      res.status(200).json(rpcError(body?.id ?? null, e.code || "internal_error", e.message));
      return;
    }
    console.error(JSON.stringify({ rid, scope: "mcp-v2", error: e.message }));
    res.status(500).json(rpcError(body?.id ?? null, -32603, e.message));
  }
}
