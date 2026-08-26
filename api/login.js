// 대시보드 비밀번호 확인 → 인증 쿠키 발급
// Required environment variable: DASHBOARD_PASSWORD

import { createHash, timingSafeEqual } from "node:crypto";

// 비밀번호를 그대로 쿠키에 담지 않고 해시로 바꿔 저장한다.
const tokenFor = pw => createHash("sha256").update(pw + ":woos-dad-dashboard").digest("hex");

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ok:false,error:"Method not allowed"});

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return res.status(503).json({
    ok:false,
    error:"DASHBOARD_PASSWORD is not configured"
  });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const given = String((body && body.password) || "");

  const a = Buffer.from(tokenFor(given), "hex");
  const b = Buffer.from(tokenFor(expected), "hex");
  if (!timingSafeEqual(a, b)) {
    return res.status(401).json({ok:false,error:"비밀번호가 맞지 않습니다"});
  }

  res.setHeader("Set-Cookie",
    `dash=${tokenFor(expected)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${THIRTY_DAYS}`);
  return res.status(200).json({ok:true});
}
