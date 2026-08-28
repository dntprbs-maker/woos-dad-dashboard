// Public endpoint for the personal Android home-screen widget.
// Returns only the fields needed to render Dad's "확인필요" list.
// It never returns task descriptions, assignees, Git links, attachments, or Notion page URLs.
// Required environment variable: NOTION_TOKEN
// Optional: NOTION_DATABASE_ID

const DATABASE_ID =
  process.env.NOTION_DATABASE_ID || "8ba2d174-b03c-8369-b0a2-07b234b93430";

async function notionQuery(token, start_cursor) {
  const body = { page_size: 100 };
  if (start_cursor) body.start_cursor = start_cursor;

  const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

function text(prop) {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map(x => x.plain_text || "").join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map(x => x.plain_text || "").join("");
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: "NOTION_TOKEN is not configured" });

  try {
    let cursor;
    let unfinished = 0;
    const items = [];

    do {
      const data = await notionQuery(token, cursor);
      for (const page of data.results || []) {
        const p = page.properties || {};

        let status = text(p["상태"]);
        if (status !== "완료") unfinished++;

        const checked = p["확인필요"]?.type === "checkbox" && p["확인필요"].checkbox;
        if (checked) {
          items.push({
            id: page.id,
            title: text(p["작업명"]) || "(제목 없음)",
            project: text(p["프로젝트명"]),
            status
          });
        }
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({
      ok: true,
      needsCheck: items.length,
      unfinished,
      items
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "summary unavailable" });
  }
}
