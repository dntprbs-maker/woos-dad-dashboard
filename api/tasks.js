// Vercel Serverless Function: Notion 작업·업무협업 DB 읽기
// Required environment variables: NOTION_TOKEN, DASHBOARD_PASSWORD
// Optional: NOTION_DATABASE_ID (defaults to current WOO'S 메모리허브 DB)
//
// ⚠️ 이 엔드포인트는 노션 실데이터를 반환하므로 반드시 인증을 거친다.
//    DASHBOARD_PASSWORD가 설정돼 있지 않으면 데이터를 내주지 않고 503으로 막는다.

import { createHash, timingSafeEqual } from "node:crypto";

const tokenFor = pw => createHash("sha256").update(pw + ":woos-dad-dashboard").digest("hex");

function isAuthed(req, expected) {
  const m = /(?:^|;\s*)dash=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return false;
  return timingSafeEqual(Buffer.from(m[1], "hex"), Buffer.from(tokenFor(expected), "hex"));
}

const DATABASE_ID =
  process.env.NOTION_DATABASE_ID || "8ba2d174-b03c-8369-b0a2-07b234b93430";

function plain(prop) {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map(x => x.plain_text || "").join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map(x => x.plain_text || "").join("");
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
  if (prop.type === "people") return (prop.people || []).map(x => x.name || x.person?.email || "").join(", ");
  if (prop.type === "date") return prop.date?.start || "";
  if (prop.type === "checkbox") return !!prop.checkbox;
  if (prop.type === "formula") {
    const f = prop.formula || {};
    return f.string ?? f.number ?? f.boolean ?? f.date?.start ?? "";
  }
  if (prop.type === "rollup") {
    const r = prop.rollup || {};
    if (r.type === "array") return r.array.map(plain).filter(Boolean).join(", ");
    return r.number ?? r.date?.start ?? "";
  }
  return "";
}

// 담당자 = 「담당자」 Relation(👥 직원·에이전트 DB). 구형 「작업자」 select는 읽지 않는다.
// Relation에는 직원 페이지 ID만 들어 있으므로 페이지 제목에서 이름을 읽고,
// MCP(displayName)와 같은 규칙으로 "01.아빠"→"아빠", "반짝이 (Gemini)"→"반짝이"로 정리한다.
const NAME_TTL_MS = 10 * 60 * 1000;
const nameCache = new Map(); // id -> { name, at }
const displayName = n => n.replace(/^\s*\d+\.\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();

async function employeeName(token, id) {
  const hit = nameCache.get(id);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    headers: { "Authorization": `Bearer ${token}`, "Notion-Version": "2022-06-28" }
  });
  if (!r.ok) throw new Error(`Notion ${r.status} (직원 페이지 ${id})`);
  const page = await r.json();
  const title = Object.values(page.properties || {}).find(x => x.type === "title");
  const name = displayName(plain(title)) || id;
  nameCache.set(id, { name, at: Date.now() });
  return name;
}

async function notionQuery(token, start_cursor) {
  const body = { page_size: 100 };
  if (start_cursor) body.start_cursor = start_cursor;

  const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text.slice(0,500)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ok:false,error:"Method not allowed"});

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.status(503).json({
    ok:false,
    error:"DASHBOARD_PASSWORD is not configured"
  });
  if (!isAuthed(req, password)) return res.status(401).json({ok:false,error:"unauthorized"});

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(503).json({
    ok:false,
    error:"NOTION_TOKEN is not configured"
  });

  try {
    let cursor = undefined;
    const pages = [];
    do {
      const data = await notionQuery(token, cursor);
      pages.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    // 담당자 Relation의 직원 ID → 이름 (중복 제거 후 병렬 조회, 실패하면 오류로 처리 — 말없이 비우지 않는다)
    const ids = [...new Set(pages.flatMap(pg => (pg.properties?.["담당자"]?.relation || []).map(x => x.id)))];
    const names = new Map(await Promise.all(ids.map(async id => [id, await employeeName(token, id)])));
    const workerOf = pg => (pg.properties?.["담당자"]?.relation || []).map(x => names.get(x.id)).filter(Boolean).join(", ");

    const tasks = pages.map(page => {
      const p = page.properties || {};
      return {
        id: page.id,
        title: plain(p["작업명"]),
        description: plain(p["작업내용"]),
        status: plain(p["상태"]),
        priority: plain(p["우선순위"]),
        // 외부 응답의 이름은 worker로 유지(대시보드 호환). 값의 원본은 「담당자」 Relation이며,
        // 여러 명이면 ", "로 이어 붙이고 없으면 "". 구형 「작업자」 select는 읽지 않는다.
        worker: workerOf(page),
        project: plain(p["프로젝트명"]),
        needsCheck: !!plain(p["확인필요"]),
        completedAt: plain(p["완료일시"]),
        workDate: plain(p["작업일"]),
        url: page.url
      };
    });

    // 인증이 필요한 응답이므로 공유 캐시(Vercel 엣지)에 절대 남기지 않는다
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ok:true,count:tasks.length,tasks});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ok:false,error:e.message});
  }
}
