// AI 공용 대화방 (Notion 「AI 공용 대화방」 DB)
//
// AI끼리 업무 지시와 결과 보고를 주고받는 메신저다. 사람은 여기에 직접 쓰지 않는다.
//
// 이 모듈이 있는 이유 — 2026-09-03에 지시 하나가 통째로 묻혔다.
// 메시지가 속성(발신자·수신자·상태)을 채우지 않은 채 본문에만 텍스트로 적혀 등록됐고,
// 읽는 쪽이 `상태 != 처리완료` 로 조회하는 바람에 상태가 빈 그 행이 조용히 빠졌다.
// 오류도 경고도 없이 사라졌고, 사람이 물어봐서야 발견됐다.
//
// 그래서 두 가지를 서버에서 강제한다.
//  - 등록할 때: 발신자·수신자·제목·내용이 하나라도 비면 거절한다. 반쪽짜리 메시지를 못 만든다.
//  - 조회할 때: 수신자로 서버측 필터를 걸지 않는다. 수신자가 빈 행까지 일단 가져와서
//    malformed 로 따로 알린다. 규칙을 어긴 메시지가 들어와도 최소한 묻히지는 않는다.

import {
  resolveSourceRef, retrieveSourceMeta, querySource,
  createPageIn, retrievePageIn, updatePageIn, listBlocksIn
} from "./notion.js";
import { decode, encode } from "./tasks.js";
import { ApiError } from "./errors.js";
import { resolveEmployeeId } from "./employees.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

// 정규 필드명 -> 후보 Notion 속성명(앞쪽 우선)
const ALIASES = {
  title:       ["제목"],
  sender:      ["발신자"],
  recipients:  ["수신자"],
  status:      ["상태"],
  body:        ["내용"],
  relatedTask: ["관련작업"],
  createdAt:   ["작성시간"],
  // 2026-09-08 직원명부 Relation 전환(4단계-공통). 아직 없는 대화방 DB에서도
  // 안전하게 동작해야 하므로 없으면 map.senderEmployee/recipientEmployee가
  // undefined로 남고, 그 경우 sendMessage()는 Relation을 건너뛴다(에러 아님) —
  // "AI 공용 대화방 구조를 임의로 바꾸지 않는다"는 기존 원칙과 충돌하지 않기 위함.
  senderEmployee:    ["발신자_직원"],
  recipientEmployee: ["수신자_직원"]
};

export const STATUS_NEW = "새메시지";
export const STATUS_SEEN = "확인";
export const STATUS_DONE = "처리완료";

// 수신자에 이 값이 들어 있으면 모두에게 온 것으로 본다.
const EVERYONE = "전체";

// 등록할 때 반드시 채워야 하는 것. 하나라도 비면 등록 자체를 거절한다.
const REQUIRED = [
  ["sender", "발신자"],
  ["recipients", "수신자"],
  ["title", "제목"],
  ["body", "내용"]
];

let sourceCache = null; // { ref, props, map, title, fetchedAt }

/**
 * 대화방 데이터소스를 알아낸다.
 *
 * 프로젝트 원장과 달리 작업 DB와 관계로 이어져 있지 않아 유도할 수가 없다.
 * 그래서 여기만 환경변수를 쓴다.
 */
export async function messengerSource({ force = false } = {}) {
  if (sourceCache && !force && Date.now() - sourceCache.fetchedAt < CACHE_TTL_MS) {
    return sourceCache;
  }

  const id = (
    process.env.NOTION_MESSENGER_DATA_SOURCE_ID ||
    process.env.NOTION_MESSENGER_DATABASE_ID ||
    ""
  ).trim();

  if (!id) {
    throw new ApiError(503, "messenger_not_configured",
      "AI 공용 대화방 데이터소스가 설정되지 않았습니다. " +
      "환경변수 NOTION_MESSENGER_DATA_SOURCE_ID 에 대화방 DB의 데이터소스 ID를 넣으세요.");
  }

  let ref;
  try {
    ref = await resolveSourceRef(id);
  } catch (e) {
    if (e.status === 404) {
      throw new ApiError(503, "messenger_unavailable",
        "대화방 DB를 읽지 못했습니다(404). 노션에서 「AI 공용 대화방」 DB에 이 Integration이 " +
        "연결돼 있는지 확인하세요. 연결돼 있지 않으면 노션이 DB 자체를 없는 것처럼 응답합니다.");
    }
    throw e;
  }

  const meta = await retrieveSourceMeta(ref);
  const props = meta.properties || {};
  const map = {};
  for (const [field, candidates] of Object.entries(ALIASES)) {
    const hit = candidates.find(n => Object.prototype.hasOwnProperty.call(props, n));
    if (hit) map[field] = hit;
  }
  if (!map.title) {
    map.title = Object.keys(props).find(k => props[k].type === "title") || null;
  }

  sourceCache = {
    ref,
    props,
    map,
    title: (meta.title || []).map(t => t.plain_text || "").join("") || null,
    fetchedAt: Date.now()
  };
  return sourceCache;
}

/** select / multi_select 속성이 허용하는 이름 목록 */
function optionsOf(prop) {
  if (!prop) return [];
  if (prop.type === "select") return (prop.select?.options || []).map(o => o.name);
  if (prop.type === "multi_select") return (prop.multi_select?.options || []).map(o => o.name);
  if (prop.type === "status") return (prop.status?.options || []).map(o => o.name);
  return [];
}

function toMessage(page, map) {
  const p = page.properties || {};
  const out = {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: !!page.archived
  };
  for (const [field, propName] of Object.entries(map)) {
    if (propName) out[field] = decode(p[propName]);
  }
  if (!Array.isArray(out.recipients)) {
    out.recipients = out.recipients ? [out.recipients] : [];
  }
  return out;
}

/** 페이지 본문 블록을 평문으로. 속성이 비어 있는 메시지의 실제 내용을 건지는 데 쓴다. */
async function readBlocks(ref, pageId, limit = 30) {
  try {
    const children = await listBlocksIn(ref, pageId, limit);
    return (children.results || [])
      .map(b => {
        const body = b[b.type];
        const rt = body && body.rich_text;
        return Array.isArray(rt) ? rt.map(x => x.plain_text || "").join("") : "";
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------- 조회 */

/**
 * 내 미처리 수신함.
 *
 * 서버측 필터는 상태에만 건다. 수신자로는 거르지 않는다 — 수신자 속성이 비어 있는
 * 메시지가 필터에서 조용히 빠지는 것이 정확히 2026-09-03 사고의 원인이었다.
 * 대신 가져온 뒤 코드에서 나눈다: 제대로 된 것은 messages, 속성이 빠진 것은 malformed.
 */
export async function checkMessages(q = {}) {
  const me = String(q.me || "").trim();
  if (!me) {
    throw new ApiError(400, "invalid_request",
      "me(내 이름)가 필요합니다. 자기 이름을 정확히 넣으세요. 예: 'Claude Code'. " +
      "다른 AI 앞으로 온 지시를 대신 처리하면 안 됩니다.");
  }

  const { ref, props, map } = await messengerSource();

  const recipientOptions = optionsOf(props[map.recipients]);
  if (recipientOptions.length && !recipientOptions.includes(me)) {
    throw new ApiError(400, "unknown_identity",
      "「" + me + "」는 대화방의 수신자 선택지에 없는 이름입니다. " +
      "쓸 수 있는 이름: " + recipientOptions.join(", "));
  }

  // 상태가 처리완료가 아닌 것 + 상태가 아예 빈 것.
  // is_empty 를 빼면 속성이 안 채워진 메시지를 놓친다.
  const statusProp = map.status;
  const filter = statusProp
    ? {
        or: [
          { property: statusProp, select: { does_not_equal: STATUS_DONE } },
          { property: statusProp, select: { is_empty: true } }
        ]
      }
    : undefined;

  const page = await querySource(ref, {
    filter,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    pageSize: Math.min(100, Math.max(1, Number(q.limit) || 50))
  });

  const inbox = [];
  const others = [];
  const malformed = [];

  for (const pg of page.results || []) {
    const m = toMessage(pg, map);

    const missing = [];
    if (!m.sender) missing.push("발신자");
    if (!m.recipients.length) missing.push("수신자");
    if (!m.status) missing.push("상태");
    if (!m.title) missing.push("제목");
    if (!m.body) missing.push("내용");

    if (missing.length) {
      malformed.push({ ...m, missing });
      continue;
    }
    if (m.recipients.includes(me) || m.recipients.includes(EVERYONE)) inbox.push(m);
    else others.push({ id: m.id, title: m.title, sender: m.sender, recipients: m.recipients, status: m.status });
  }

  // 속성이 빠진 메시지는 본문에 진짜 내용이 들어 있는 경우가 많다(2026-09-03 건이 그랬다).
  // 사람이 판단할 수 있도록 본문을 같이 건져 준다. 드물어야 하므로 5건까지만 읽는다.
  for (const m of malformed.slice(0, 5)) {
    m.contentPreview = await readBlocks(ref, m.id);
  }

  const result = {
    ok: true,
    me,
    count: inbox.length,
    messages: inbox,
    othersCount: others.length,
    has_more: !!page.has_more
  };

  if (malformed.length) {
    result.malformed = malformed;
    result.malformedNote =
      "아래 메시지는 필수 속성(" +
      [...new Set(malformed.flatMap(m => m.missing))].join(", ") +
      ")이 비어 있어 누구 앞으로 온 것인지 확정할 수 없습니다. " +
      "본문(contentPreview)을 읽어 내 앞으로 온 것인지 판단하고, 남의 것이면 손대지 마세요. " +
      "이런 메시지는 send_message 를 쓰지 않고 등록해서 생깁니다. 보낸 쪽에 알려 주세요.";
  }

  return result;
}

/** 메시지 한 건 (본문 포함) */
export async function getMessage(id, opts = {}) {
  const { ref, map } = await messengerSource();
  const page = await retrievePageIn(ref, id);
  const message = toMessage(page, map);
  if (opts.blocks !== false) {
    const content = await readBlocks(ref, id);
    if (content) message.content = content;
  }
  return { ok: true, message };
}

/** 대화방 조건 조회 — 스레드를 되짚어 볼 때. */
export async function listMessages(q = {}) {
  const { ref, props, map } = await messengerSource();
  const and = [];

  if (q.status) {
    const values = String(q.status).split(",").map(s => s.trim()).filter(Boolean);
    and.push(values.length === 1
      ? { property: map.status, select: { equals: values[0] } }
      : { or: values.map(v => ({ property: map.status, select: { equals: v } })) });
  }
  if (q.sender) and.push({ property: map.sender, select: { equals: String(q.sender) } });
  if (q.recipient) and.push({ property: map.recipients, multi_select: { contains: String(q.recipient) } });
  if (q.q && map.title) and.push({ property: map.title, title: { contains: String(q.q) } });
  if (q.relatedTask && map.relatedTask) {
    and.push({ property: map.relatedTask, rich_text: { contains: String(q.relatedTask) } });
  }

  const filter = !and.length ? undefined : (and.length === 1 ? and[0] : { and });
  const page = await querySource(ref, {
    filter,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    pageSize: Math.min(100, Math.max(1, Number(q.limit) || 25)),
    startCursor: q.cursor || undefined
  });

  return {
    ok: true,
    count: (page.results || []).length,
    has_more: !!page.has_more,
    next_cursor: page.next_cursor || null,
    messages: (page.results || []).map(pg => toMessage(pg, map))
  };
}

/* ---------------------------------------------------------------- 등록 */

/**
 * 메시지 등록.
 *
 * 필수 속성이 하나라도 비면 만들지 않는다. 반쪽짜리 메시지는 받는 쪽 조회에서
 * 빠져 묻히기 때문에, 애초에 만들지 못하게 막는 것이 이 함수의 존재 이유다.
 *
 * 2026-09-08 직원명부 Relation 전환(4단계-공통):
 *  - 대화방 DB에 발신자_직원/수신자_직원 Relation이 있으면(map.senderEmployee /
 *    map.recipientEmployee) 기존 발신자(select)·수신자(multi_select)와 함께
 *    채운다. Relation이 아직 없는 환경(스키마 자체에 없음)에서는 조용히
 *    건너뛴다 — 그건 이 함수의 책임 밖이다.
 *  - 하지만 Relation 속성 자체는 있는데 이름을 직원명부에서 못 찾은 경우는
 *    다르다. 그건 "아직 안 만들어진 기능"이 아니라 "식별에 실패한 요청"이므로
 *    조용히 select만 채우고 넘어가지 않고 명확히 실패시킨다 — 그렇게 하면
 *    수신자_직원 기준으로 도는 poller가 이 메시지를 영원히 못 찾기 때문이다.
 *    "Claude Code" 같은 옛 이름을 코드디/코드앤 등으로 추측 매핑하지도 않는다.
 *  - 원칙 "메시지 1건 = 발신자 1명 → 수신자 1명": 수신자_직원 Relation이 1개
 *    페이지만 담을 수 있으므로, recipients가 여러 명이면 대화방 페이지를
 *    수신자 수만큼 각각 만든다. recipients가 1명이면 지금까지와 동일하게
 *    페이지 1건만 생긴다(기존 호출부와 100% 호환).
 */
export async function sendMessage(input = {}) {
  const { ref, props, map } = await messengerSource();

  const sender = String(input.sender || "").trim();
  const title = String(input.title || "").trim();
  const body = String(input.body ?? input.content ?? "").trim();
  const recipients = (Array.isArray(input.recipients) ? input.recipients : [input.recipients])
    .map(r => String(r || "").trim())
    .filter(Boolean);

  const values = { sender, recipients, title, body };
  const missing = REQUIRED
    .filter(([field]) => {
      const v = values[field];
      return Array.isArray(v) ? !v.length : !v;
    })
    .map(([, label]) => label);

  if (missing.length) {
    throw new ApiError(400, "incomplete_message",
      "메시지를 등록하지 않았습니다. 다음이 비어 있습니다: " + missing.join(", ") + ". " +
      "속성을 채우지 않은 메시지는 받는 쪽 조회에서 빠져 묻힙니다. " +
      "내용을 본문에만 적는 것은 등록으로 인정하지 않습니다.",
      { missing });
  }

  // 오타로 새 선택지가 생기는 것을 막는다. 노션은 없는 이름을 주면 옵션을 만들어 버린다.
  const senderOptions = optionsOf(props[map.sender]);
  if (senderOptions.length && !senderOptions.includes(sender)) {
    throw new ApiError(400, "unknown_sender",
      "「" + sender + "」는 발신자 선택지에 없습니다. 쓸 수 있는 이름: " + senderOptions.join(", "));
  }
  const recipientOptions = optionsOf(props[map.recipients]);
  const badRecipients = recipientOptions.length
    ? recipients.filter(r => !recipientOptions.includes(r))
    : [];
  if (badRecipients.length) {
    throw new ApiError(400, "unknown_recipient",
      "수신자 선택지에 없는 이름입니다: " + badRecipients.join(", ") +
      ". 쓸 수 있는 이름: " + recipientOptions.join(", "));
  }

  // 직원명부 Relation 대상 이름을 미리 전부 확인한다. 하나라도 실패하면
  // 페이지를 하나도 만들지 않는다 — 수신자 3명 중 2명만 만들어지는 반쪽짜리
  // 등록을 막기 위함(위쪽의 REQUIRED 검증과 같은 이유).
  const useEmployeeRelation = !!(map.senderEmployee && map.recipientEmployee);
  let senderEmployeeId = null;
  const recipientEmployeeIds = new Map(); // name -> id

  if (useEmployeeRelation) {
    senderEmployeeId = await resolveEmployeeId(sender);
    if (!senderEmployeeId) {
      throw new ApiError(400, "sender_employee_not_found",
        "발신자 「" + sender + "」를 👥 직원·에이전트 명부에서 찾지 못했습니다. " +
        "비슷한 이름으로 추측해서 등록하지 않습니다 — 직원명부의 정확한 이름을 확인하거나, " +
        "아직 등록되지 않은 직원이면 먼저 직원명부에 추가해 주세요.");
    }

    const unresolved = [];
    for (const name of recipients) {
      if (name === EVERYONE) {
        // "전체"는 직원명부에 가짜 직원으로 만들지 않는다(운영규칙 예외 범위 밖).
        // 현재 실사용이 0건으로 확인됐으므로 임의로 팬아웃하지 않고 명확히 막는다.
        unresolved.push(name + "(전체 수신은 직원 Relation 구조에서 아직 지원하지 않습니다 — 아빠 결정 필요)");
        continue;
      }
      const id = await resolveEmployeeId(name);
      if (id) recipientEmployeeIds.set(name, id);
      else unresolved.push(name);
    }
    if (unresolved.length) {
      throw new ApiError(400, "recipient_employee_not_found",
        "다음 수신자를 👥 직원·에이전트 명부에서 찾지 못해 등록하지 않았습니다: " +
        unresolved.join(", ") + ". 옛 이름(예: Claude Code)을 코드디·코드앤 등으로 추측해서 " +
        "매핑하지 않습니다 — 직원명부의 정확한 이름을 다시 확인해 주세요.");
    }
  }

  const buildProps = (recipientNames, recipientEmployeeId) => {
    const properties = {
      [map.title]: encode(props[map.title], title),
      [map.sender]: encode(props[map.sender], sender),
      [map.recipients]: encode(props[map.recipients], recipientNames),
      [map.body]: encode(props[map.body], body),
      // 상태는 보내는 쪽이 정하지 않는다. 새 메시지는 언제나 미처리에서 시작한다.
      [map.status]: encode(props[map.status], STATUS_NEW)
    };
    if (input.relatedTask && map.relatedTask) {
      properties[map.relatedTask] = encode(props[map.relatedTask], String(input.relatedTask));
    }
    if (useEmployeeRelation) {
      properties[map.senderEmployee] = encode(props[map.senderEmployee], senderEmployeeId);
      if (recipientEmployeeId) {
        properties[map.recipientEmployee] = encode(props[map.recipientEmployee], recipientEmployeeId);
      }
    }
    return properties;
  };

  // recipients 1명(지금까지 절대다수 케이스)이면 페이지 1건만 만들어 기존
  // 호출부와 완전히 같은 모양으로 응답한다. 여러 명이면 수신자 수만큼
  // 페이지를 각각 만든다(한 페이지에 여러 수신자를 넣지 않는다).
  const created = [];
  for (const name of recipients) {
    const employeeId = name === EVERYONE ? null : (recipientEmployeeIds.get(name) || null);
    const page = await createPageIn(ref, buildProps([name], employeeId));
    created.push(toMessage(page, map));
  }

  return {
    ok: true,
    created: true,
    count: created.length,
    message: created[0],
    messages: created
  };
}

/* ---------------------------------------------------------------- 수정 */

/**
 * 메시지 수정. 주로 읽음 표시(상태 전이)에 쓴다.
 * 상태는 받는 쪽이 관리한다 — 내가 보낸 메시지의 상태를 내가 바꾸지 않는다.
 */
export async function updateMessage(id, body = {}) {
  const { ref, props, map } = await messengerSource();

  const properties = {};
  const errors = [];

  if (body.status !== undefined) {
    const status = String(body.status).trim();
    const options = optionsOf(props[map.status]);
    if (options.length && !options.includes(status)) {
      throw new ApiError(400, "unknown_status",
        "「" + status + "」는 상태 선택지에 없습니다. 쓸 수 있는 값: " + options.join(", "));
    }
    properties[map.status] = encode(props[map.status], status);
  }

  for (const field of ["title", "sender", "body", "relatedTask"]) {
    if (body[field] === undefined) continue;
    const propName = map[field];
    if (!propName) { errors.push("'" + field + "'에 해당하는 속성이 대화방 DB에 없습니다"); continue; }
    try {
      properties[propName] = encode(props[propName], body[field]);
    } catch (e) {
      errors.push(propName + ": " + e.message);
    }
  }

  if (body.recipients !== undefined) {
    const list = (Array.isArray(body.recipients) ? body.recipients : [body.recipients])
      .map(r => String(r || "").trim()).filter(Boolean);
    if (!list.length) {
      errors.push("수신자를 비울 수 없습니다");
    } else {
      const options = optionsOf(props[map.recipients]);
      const bad = options.length ? list.filter(r => !options.includes(r)) : [];
      if (bad.length) errors.push("수신자 선택지에 없는 이름: " + bad.join(", "));
      else properties[map.recipients] = encode(props[map.recipients], list);
    }
  }

  if (errors.length) throw new ApiError(400, "invalid_properties", errors.join(" / "));
  if (!Object.keys(properties).length) {
    throw new ApiError(400, "invalid_request", "바꿀 내용이 없습니다");
  }

  const page = await updatePageIn(ref, id, properties);
  return { ok: true, updated: true, message: toMessage(page, map) };
}

/** 여러 건의 상태를 한 번에 바꾼다. 스레드를 통째로 닫을 때. */
export async function markMessages(ids, status) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(x => String(x || "").trim()).filter(Boolean);
  if (!list.length) throw new ApiError(400, "invalid_request", "id가 필요합니다");

  const done = [];
  const failed = [];
  for (const id of list) {
    try {
      const r = await updateMessage(id, { status });
      done.push({ id, title: r.message.title, status: r.message.status });
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  return { ok: !failed.length, status, updated: done.length, done, failed };
}

/* ---------------------------------------------------------------- 보관 */

/**
 * 메시지를 노션 휴지통으로 보낸다.
 * 노션 API에는 완전 삭제가 없다. 여기서 할 수 있는 건 보관까지이고,
 * 진짜 지우는 것은 사람이 노션 휴지통에서만 할 수 있다.
 */
export async function archiveMessage(id) {
  const { ref, map } = await messengerSource();
  const page = await updatePageIn(ref, id, null, { archived: true });
  return { ok: true, archived: true, message: toMessage(page, map) };
}

/* ---------------------------------------------------------------- 스키마 */

export async function getMessengerSchema() {
  const { ref, props, map, title } = await messengerSource();
  const properties = {};
  for (const [name, p] of Object.entries(props)) {
    const entry = { type: p.type };
    const options = optionsOf(p);
    if (options.length) entry.options = options;
    properties[name] = entry;
  }
  return {
    ok: true,
    source: { id: ref.id, mode: ref.mode, title },
    fieldMap: map,
    required: REQUIRED.map(([, label]) => label),
    statuses: [STATUS_NEW, STATUS_SEEN, STATUS_DONE],
    properties
  };
}
