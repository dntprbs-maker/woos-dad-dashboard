// Vercel Serverless Function: Notion 작업·업무협업 DB 읽기
// Required environment variable: NOTION_TOKEN
// Optional: NOTION_DATABASE_ID (defaults to current WOO'S 메모리허브 DB)

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

    const tasks = pages.map(page => {
      const p = page.properties || {};
      return {
        id: page.id,
        title: plain(p["작업명"]),
        description: plain(p["작업내용"]),
        status: plain(p["상태"]),
        priority: plain(p["우선순위"]),
        worker: plain(p["수행자"]),
        project: plain(p["프로젝트명"]),
        needsCheck: !!plain(p["확인필요"]),
        completedAt: plain(p["완료일시"]),
        workDate: plain(p["작업일"]),
        url: page.url
      };
    });

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ok:true,count:tasks.length,tasks});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ok:false,error:e.message});
  }
}
