// 로컬에서 /api/v1 함수를 그대로 띄우는 개발용 서버.
// Vercel 런타임이 넣어 주는 res.status()/res.json() 만 얇게 흉내 낸다.
//
//   node --env-file=.env scripts/dev-server.mjs
//
// 배포에는 쓰이지 않는다 (api/ 밖에 있으므로 Vercel 함수로 잡히지 않음).

import { createServer } from "node:http";
import handler from "../api/v1/router.js";

const PORT = Number(process.env.PORT || 3210);

function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

createServer(async (req, res) => {
  shim(res);
  if (!req.url.startsWith("/api/v1")) {
    res.status(404).json({ ok: false, error: "not found" });
    return;
  }
  try {
    await handler(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
}).listen(PORT, () => {
  console.log("dev server on http://localhost:" + PORT + "/api/v1");
});
