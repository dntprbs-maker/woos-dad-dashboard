// Vercel Serverless Function — 「AI 공용 대화방」 새 메시지 -> Telegram 알림
//
// Notion Webhook이 이 URL을 직접 호출한다. Hermes Gateway를 거치지 않는 완전히
// 독립된 경로다 — Hermes가 죽어 있어도 이 함수는 그대로 동작한다.
//
// - "새 메시지 생성"(page.created)만 알림 대상. 내용수정/상태변경/속성변경은 무시.
// - 같은 Notion Page ID는 이벤트가 여러 번(혹은 순서가 뒤바뀌어) 와도 정확히 1회만
//   알린다 — 판단 기준은 내용이 아니라 Page ID. 별도 Notion DB(dedup 로그)에 처리한
//   Page ID를 남겨 확인한다.
// - 서명(X-Notion-Signature)을 검증해 Notion이 보낸 요청만 처리한다.
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveSourceRef, createPageIn, querySource, notionCall } from "./_lib/notion.js";
import { messengerSource, getMessage } from "./_lib/messages.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function validSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function findDedupMarkers(dedupRef, pageId) {
  const r = await querySource(dedupRef, {
    filter: { property: "PageId", title: { equals: pageId } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }]
  });
  return r.results || [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const raw = await readRawBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid json" });
  }

  // Notion Webhook 구독 등록 시 1회 오는 검증 challenge. 이 토큰을 Notion 통합
  // 설정 화면(Webhooks 탭)에 붙여넣어야 구독이 활성화된다. 이후 이 토큰은
  // X-Notion-Signature 서명의 비밀키로도 쓰인다(NOTION_MESSENGER_WEBHOOK_SECRET).
  if (body.verification_token) {
    console.log("[messenger-webhook] verification_token:", body.verification_token);
    return res.status(200).json({ ok: true });
  }

  const secret = process.env.NOTION_MESSENGER_WEBHOOK_SECRET;
  const sig = req.headers["x-notion-signature"];
  if (!validSignature(raw, sig, secret)) {
    console.warn("[messenger-webhook] signature mismatch or secret not configured");
    return res.status(401).json({ ok: false, error: "bad signature" });
  }

  if (body.type !== "page.created") {
    return res.status(200).json({ ok: true, skipped: body.type || "no type" });
  }

  const pageId = body.entity?.id;
  if (!pageId) return res.status(200).json({ ok: true, skipped: "no entity id" });

  const dedupId = process.env.NOTION_MESSENGER_DEDUP_DATA_SOURCE_ID;
  if (!dedupId) return res.status(503).json({ ok: false, error: "dedup source not configured" });

  try {
    // 이 page.created가 AI 공용 대화방 소속인지 확인한다 — 이 워크스페이스의
    // 다른 DB에서 생긴 page.created까지 여기서 처리하지 않도록.
    const { ref: messengerRef } = await messengerSource();
    const rawPage = await notionCall(`/pages/${pageId}`, { version: "2025-09-03" });
    const parentId = rawPage.parent?.data_source_id || rawPage.parent?.database_id;
    if (!parentId || parentId !== messengerRef.id) {
      return res.status(200).json({ ok: true, skipped: "not messenger db" });
    }

    const dedupRef = await resolveSourceRef(dedupId);

    const before = await findDedupMarkers(dedupRef, pageId);
    if (before.length > 0) {
      return res.status(200).json({ ok: true, skipped: "duplicate", pageId });
    }

    const { message: msg } = await getMessage(pageId, { blocks: false });

    // dedup 마커를 먼저 만든다 — Telegram 발송 전에 만들어서 경쟁 구간을 최소화한다.
    const marker = await createPageIn(dedupRef, {
      PageId: { title: [{ text: { content: pageId } }] },
      SourceTitle: { rich_text: [{ text: { content: String(msg.title || "").slice(0, 200) } }] }
    });

    // 마커 생성 직후 재조회 — 동시에 두 요청이 마커를 만들었다면 가장 먼저
    // 생긴 것만 알림을 보낸다(page.created/page.content_updated가 근접 시간에
    // 같이 도착해도 정확히 1회만 보내기 위한 안전장치).
    const after = await findDedupMarkers(dedupRef, pageId);
    const winnerId = after[0]?.id;
    if (winnerId && winnerId !== marker.id) {
      return res.status(200).json({ ok: true, skipped: "lost race", pageId });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_AI_MESSENGER_CHAT_ID;
    if (!botToken || !chatId) return res.status(503).json({ ok: false, error: "telegram not configured" });

    const recipients = Array.isArray(msg.recipients) ? msg.recipients.join(", ") : (msg.recipients || "?");
    const bodyText = String(msg.body || "");
    const summary = bodyText.length > 200 ? bodyText.slice(0, 200) + "…" : bodyText;
    const text = [
      "📬 AI 공용대화방 새 메시지",
      "",
      `발신: ${msg.sender || "?"}`,
      `수신: ${recipients}`,
      `제목: ${msg.title || "(제목 없음)"}`,
      summary ? `\n${summary}` : "",
      msg.url || ""
    ].filter(Boolean).join("\n");

    const tg = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!tg.ok) throw new Error(`Telegram ${tg.status}: ${(await tg.text()).slice(0, 300)}`);

    return res.status(200).json({ ok: true, notified: true, pageId });
  } catch (e) {
    console.error("[messenger-webhook]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
