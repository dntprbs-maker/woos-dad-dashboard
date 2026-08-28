// Public, count-only endpoint for the personal Android home-screen widget.
// Returns aggregate counts only. It never returns task titles, descriptions, assignees, or page URLs.
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

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: "NOTION_TOKEN is not configured" });

  try {
    let cursor;
    let needsCheck = 0;
    let unfinished = 0;

    do {
      const data = await notionQuery(token, cursor);
      for (const page of data.results || []) {
        const p = page.properties || {};
        if (p["확인필요"]?.type === "checkbox" && p["확인필요"].checkbox) needsCheck++;

        let status = "";
        const prop = p["상태"];
        if (prop?.type === "select") status = prop.select?.name || "";
        else if (prop?.type === "status") status = prop.status?.name || "";
        if (status !== "완료") unfinished++;
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ ok: true, needsCheck, unfinished });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "summary unavailable" });
  }
}
