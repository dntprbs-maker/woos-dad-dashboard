// 노션 운영규칙 페이지 읽기/쓰기
//
// 규칙의 Single Source of Truth는 Notion `노션 운영규칙` 페이지 하나다.
// AI별 프롬프트나 저장소마다 같은 규칙을 복사해 두지 않는다.
//
// 쓰기는 아빠가 명시적으로 지시했을 때만 허용한다. 서버는 호출자가 정말 아빠인지
// 알 수 없으므로 (1) 명시 플래그와 사유를 요구하고, (2) RULES_EDIT_PASSPHRASE가
// 설정돼 있으면 그 값까지 맞아야 통과시킨다. (2)가 설정돼 있을 때만 실제 강제가 된다.

import { createHash, timingSafeEqual } from "node:crypto";
import { notionCall, NotionError } from "./notion.js";

const MAX_BLOCKS_PER_CALL = 100;

export function rulesPageId() {
  const id = process.env.NOTION_RULES_PAGE_ID;
  if (!id) {
    throw new NotionError(503, "rules_page_not_configured",
      "NOTION_RULES_PAGE_ID가 설정되지 않았습니다. 노션에서 `노션 운영규칙` 페이지를 만들고 " +
      "Integration에 연결한 뒤 그 페이지 ID를 환경변수에 넣어 주세요.");
  }
  return id.trim();
}

/* ------------------------------------------------------- 텍스트 <-> 블록 */

const rich = content => [{ type: "text", text: { content: String(content).slice(0, 2000) } }];

/** 한 줄씩 보고 제목/목록/문단으로 바꾼다. 읽을 때 같은 표기로 되돌려 왕복이 안정적이다. */
export function textToBlocks(text) {
  const blocks = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    let m;
    if ((m = /^###\s+(.*)$/.exec(line))) {
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: rich(m[1]) } });
    } else if ((m = /^##\s+(.*)$/.exec(line))) {
      blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rich(m[1]) } });
    } else if ((m = /^#\s+(.*)$/.exec(line))) {
      blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: rich(m[1]) } });
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(m[1]) } });
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rich(m[1]) } });
    } else {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rich(line) } });
    }
  }
  return blocks;
}

function blockToLine(b, ordinal) {
  const body = b[b.type];
  const rt = body && body.rich_text;
  const text = Array.isArray(rt) ? rt.map(x => x.plain_text || "").join("") : "";
  switch (b.type) {
    case "heading_1": return "# " + text;
    case "heading_2": return "## " + text;
    case "heading_3": return "### " + text;
    case "bulleted_list_item": return "- " + text;
    case "numbered_list_item": return ordinal + ". " + text;
    case "to_do": return "- [" + (body.checked ? "x" : " ") + "] " + text;
    case "quote": return "> " + text;
    case "divider": return "---";
    default: return text;
  }
}

/**
 * 노션 번호목록은 번호를 저장하지 않고 위치로 매긴다. 그대로 읽으면 전부 "1."이 되어
 * AI가 "15번 규칙"처럼 짚을 수 없으므로, 연속된 번호목록에 실제 번호를 다시 매겨 준다.
 * (쓸 때는 번호를 무시하므로 왕복해도 내용이 어긋나지 않는다)
 */
function blocksToLines(blocks) {
  const lines = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type === "numbered_list_item") n += 1;
    else n = 0;
    lines.push(blockToLine(b, n));
  }
  return lines;
}

/* ------------------------------------------------------------------ 읽기 */

async function listAllBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const page = await notionCall(`/blocks/${pageId}/children?${q}`);
    blocks.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

export async function getRules() {
  const pageId = rulesPageId();
  const [page, blocks] = await Promise.all([
    notionCall(`/pages/${pageId}`),
    listAllBlocks(pageId)
  ]);

  const titleProp = Object.values(page.properties || {}).find(p => p.type === "title");
  const title = (titleProp?.title || []).map(t => t.plain_text || "").join("") || "(제목 없음)";
  const content = blocksToLines(blocks).filter(l => l !== "").join("\n");

  return {
    ok: true,
    pageId,
    title,
    url: page.url,
    last_edited_time: page.last_edited_time,
    blockCount: blocks.length,
    content
  };
}

/* ------------------------------------------------------------------ 쓰기 */

const digest = s => createHash("sha256").update(String(s)).digest();

function checkPermission({ dadApproved, reason, passphrase }) {
  if (dadApproved !== true) {
    throw new NotionError(403, "not_authorized",
      "운영규칙은 아빠가 명시적으로 변경을 지시했을 때만 고칠 수 있습니다. " +
      "AI 스스로의 판단으로는 바꾸지 마세요. 아빠의 지시가 있었다면 dadApproved=true 와 reason(지시 내용)을 함께 보내세요.");
  }
  if (!reason || String(reason).trim().length < 5) {
    throw new NotionError(400, "reason_required",
      "reason에 아빠가 무엇을 지시했는지 적어 주세요 (5자 이상). 변경 이력을 남기기 위한 것입니다.");
  }

  // 설정돼 있을 때만 실제 강제가 된다. 아빠만 아는 값이라 AI가 지어낼 수 없다.
  const expected = process.env.RULES_EDIT_PASSPHRASE;
  if (expected) {
    if (!passphrase) {
      throw new NotionError(403, "passphrase_required",
        "이 워크스페이스는 운영규칙 변경에 아빠의 암구호를 요구합니다. 아빠께 여쭤보고 passphrase로 전달하세요.");
    }
    if (!timingSafeEqual(digest(passphrase), digest(expected))) {
      throw new NotionError(403, "passphrase_invalid", "암구호가 맞지 않습니다.");
    }
  }
}

// 블록을 하나씩 지우면 23개만 돼도 Vercel 30초 제한을 넘긴다(실측 504).
// 노션 rate limit(평균 초당 3요청)을 감안해 조금씩 나눠 동시에 지운다. 429는 클라이언트가 재시도한다.
const DELETE_CONCURRENCY = 5;

async function deleteAllBlocks(pageId) {
  const blocks = await listAllBlocks(pageId);
  for (let i = 0; i < blocks.length; i += DELETE_CONCURRENCY) {
    await Promise.all(
      blocks.slice(i, i + DELETE_CONCURRENCY)
        .map(b => notionCall(`/blocks/${b.id}`, { method: "DELETE" }))
    );
  }
  return blocks.length;
}

async function appendBlocksChunked(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_CALL) {
    await notionCall(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(i, i + MAX_BLOCKS_PER_CALL) }
    });
  }
}

/**
 * mode: "replace"(전체 교체 — 수정·삭제) | "append"(뒤에 덧붙이기 — 추가)
 * 수정 후 반드시 다시 읽어 실제 반영 여부를 검증해 돌려준다.
 */
export async function updateRules({ mode = "replace", content, dadApproved, reason, passphrase } = {}) {
  checkPermission({ dadApproved, reason, passphrase });

  if (typeof content !== "string" || !content.trim()) {
    throw new NotionError(400, "invalid_request", "content(규칙 본문)가 필요합니다.");
  }
  if (mode !== "replace" && mode !== "append") {
    throw new NotionError(400, "invalid_request", "mode는 replace 또는 append여야 합니다.");
  }

  const pageId = rulesPageId();
  const before = await getRules();
  const blocks = textToBlocks(content);
  if (!blocks.length) {
    throw new NotionError(400, "invalid_request", "content에서 만들 수 있는 블록이 없습니다.");
  }

  // 순서가 중요하다. 지우고 나서 넣다가 중간에 끊기면 페이지가 비어 버린다(실측으로 한 번 겪음).
  // 넣고 나서 지우면 최악의 경우 옛 내용과 새 내용이 함께 남을 뿐이라 눈에 보이고 복구도 쉽다.
  const oldBlocks = mode === "replace" ? await listAllBlocks(pageId) : [];
  await appendBlocksChunked(pageId, blocks);

  let deleted = 0;
  if (oldBlocks.length) {
    for (let i = 0; i < oldBlocks.length; i += DELETE_CONCURRENCY) {
      await Promise.all(
        oldBlocks.slice(i, i + DELETE_CONCURRENCY)
          .map(b => notionCall(`/blocks/${b.id}`, { method: "DELETE" }))
      );
    }
    deleted = oldBlocks.length;
  }

  // 검증: 실제로 반영됐는지 다시 읽는다
  const after = await getRules();
  const expected = mode === "replace"
    ? blocks.length
    : before.blockCount + blocks.length;

  return {
    ok: true,
    updated: true,
    mode,
    reason,
    deletedBlocks: deleted,
    addedBlocks: blocks.length,
    verified: after.blockCount === expected,
    blockCountBefore: before.blockCount,
    blockCountAfter: after.blockCount,
    last_edited_time: after.last_edited_time,
    url: after.url,
    content: after.content
  };
}
