// Vercel Serverless Function: Notion 작업의 '확인필요' 체크 해제
import { createHash, timingSafeEqual } from "node:crypto";

const tokenFor = pw => createHash("sha256").update(pw + ":woos-dad-dashboard").digest("hex");
function isAuthed(req, expected) {
  const m = /(?:^|;\s*)dash=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return false;
  return timingSafeEqual(Buffer.from(m[1], "hex"), Buffer.from(tokenFor(expected), "hex"));
}
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ok:false,error:"Method not allowed"});
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.status(503).json({ok:false,error:"DASHBOARD_PASSWORD is not configured"});
  if (!isAuthed(req, password)) return res.status(401).json({ok:false,error:"unauthorized"});
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(503).json({ok:false,error:"NOTION_TOKEN is not configured"});
  const pageId = String(req.body?.id || "").trim();
  if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) return res.status(400).json({ok:false,error:"invalid task id"});
  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method:"PATCH",
      headers:{"Authorization":`Bearer ${token}`,"Notion-Version":"2022-06-28","Content-Type":"application/json"},
      body:JSON.stringify({properties:{"확인필요":{checkbox:false}}})
    });
    if(!r.ok){ const text=await r.text(); throw new Error(`Notion ${r.status}: ${text.slice(0,500)}`); }
    res.setHeader("Cache-Control","private, no-store");
    return res.status(200).json({ok:true,id:pageId});
  } catch(e){ console.error(e); return res.status(500).json({ok:false,error:e.message}); }
}
