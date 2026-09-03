// AI 실행상태 + heartbeat (Notion `🫀 AI 실행상태` DB)
//
// 아빠와 초롱이가 "Claude Code가 지금 실제로 작업 중인지, 멈췄는지"를 공용으로
// 확인할 수 있게 하는 상태 원본이다. AI 메신저(새메시지/확인/처리완료)와는 완전히
// 별개 체계다 — 저 상태는 메시지를 읽었는지를, 이 상태는 프로세스가 살아서
// 움직이고 있는지를 나타낸다.
//
// 설계:
//  - AI 하나당 페이지 한 장(싱글턴). 매 heartbeat는 그 페이지의 `마지막활동시간`만 갱신한다.
//  - `마지막활동시간`은 항상 서버 시각(now)으로 찍는다 — 호출자 시계 오차를 신뢰하지 않는다.
//  - "멈췄다"는 상태값이 아니라 `마지막활동시간`과의 나이(초)로 판단한다.
//    상태를 못 바꾸고 죽어도(크래시) last_activity가 갱신을 멈추므로 나이만으로 걸러진다.

import {
  resolveSourceRef, retrieveSourceMeta, querySource,
  createPageIn, updatePageIn
} from "./notion.js";
import { decode, encode } from "./tasks.js";
import { ApiError } from "./errors.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_SECONDS = Number(process.env.AGENT_STATUS_STALE_SECONDS || 60);

export const STATE_WAITING = "대기";
export const STATE_WORKING = "작업중";
export const STATE_DONE = "완료";
export const STATE_ERROR = "오류·중단";
export const STATES = [STATE_WAITING, STATE_WORKING, STATE_DONE, STATE_ERROR];

// END 상태로 들어올 때 종료시각을 찍는다. 작업중은 아직 끝난 게 아니므로 제외.
const END_STATES = new Set([STATE_WAITING, STATE_DONE, STATE_ERROR]);

const ALIASES = {
  ai:         ["AI이름"],
  status:     ["실행상태"],
  taskName:   ["현재작업명"],
  startedAt:  ["작업시작시간"],
  lastActivity: ["마지막활동시간"],
  endedAt:    ["종료시각"],
  sessionId:  ["세션ID"],
  pid:        ["PID"],
  note:       ["메모"]
};

let sourceCache = null; // { ref, props, map, title, fetchedAt }

export async function agentStatusSource({ force = false } = {}) {
  if (sourceCache && !force && Date.now() - sourceCache.fetchedAt < CACHE_TTL_MS) {
    return sourceCache;
  }

  const id = (process.env.AGENT_STATUS_DATA_SOURCE_ID || "").trim();
  if (!id) {
    throw new ApiError(503, "agent_status_not_configured",
      "AI 실행상태 데이터소스가 설정되지 않았습니다. " +
      "환경변수 AGENT_STATUS_DATA_SOURCE_ID 에 `🫀 AI 실행상태` DB의 데이터소스 ID를 넣으세요.");
  }

  let ref;
  try {
    ref = await resolveSourceRef(id);
  } catch (e) {
    if (e.status === 404) {
      throw new ApiError(503, "agent_status_unavailable",
        "AI 실행상태 DB를 읽지 못했습니다(404). 노션에서 이 Integration이 연결돼 있는지 확인하세요.");
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
  if (!map.ai) {
    map.ai = Object.keys(props).find(k => props[k].type === "title") || null;
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

function optionsOf(prop) {
  if (!prop) return [];
  if (prop.type === "select") return (prop.select?.options || []).map(o => o.name);
  return [];
}

function toRecord(page, map) {
  const p = page.properties || {};
  const out = { id: page.id, url: page.url, last_edited_time: page.last_edited_time };
  for (const [field, propName] of Object.entries(map)) {
    if (propName) out[field] = decode(p[propName]);
  }
  return out;
}

/** last_activity 기준 판정. 상태값을 못 믿는 상황(크래시)을 가정하고 나이만으로도 계산한다. */
function judge(record, staleSeconds) {
  const now = Date.now();
  const lastActivity = record.lastActivity ? new Date(record.lastActivity).getTime() : null;
  const ageSeconds = lastActivity !== null ? Math.max(0, Math.round((now - lastActivity) / 1000)) : null;
  const stale = ageSeconds !== null && ageSeconds > staleSeconds;
  const suspectedHung = stale && record.status === STATE_WORKING;

  let judgedLabel;
  if (ageSeconds === null) judgedLabel = "활동기록 없음";
  else if (suspectedHung) judgedLabel = "정지 의심 (마지막 활동 " + ageSeconds + "초 전, 상태는 작업중)";
  else if (stale && record.status !== STATE_DONE) judgedLabel = "응답 없음 의심 (마지막 활동 " + ageSeconds + "초 전)";
  else judgedLabel = record.status || "알수없음";

  return {
    ...record,
    lastActivityAgeSeconds: ageSeconds,
    staleThresholdSeconds: staleSeconds,
    stale,
    suspectedHung,
    judgedLabel
  };
}

/* ---------------------------------------------------------------- 조회 */

export async function getAgentStatus(ai, opts = {}) {
  const name = String(ai || "").trim();
  if (!name) throw new ApiError(400, "invalid_request", "ai(AI 이름)가 필요합니다");

  const { ref, map } = await agentStatusSource();
  const page = await querySource(ref, {
    filter: { property: map.ai, title: { equals: name } },
    pageSize: 1
  });

  const staleSeconds = Number(opts.staleSeconds) || DEFAULT_STALE_SECONDS;
  const found = (page.results || [])[0];
  if (!found) {
    return { ok: true, found: false, ai: name, note: "이 AI의 실행상태 기록이 아직 없습니다." };
  }

  return { ok: true, found: true, status: judge(toRecord(found, map), staleSeconds) };
}

export async function listAgentStatus(opts = {}) {
  const { ref, map } = await agentStatusSource();
  const page = await querySource(ref, { pageSize: 100 });
  const staleSeconds = Number(opts.staleSeconds) || DEFAULT_STALE_SECONDS;
  const statuses = (page.results || []).map(p => judge(toRecord(p, map), staleSeconds));
  return { ok: true, count: statuses.length, staleThresholdSeconds: staleSeconds, statuses };
}

/* ---------------------------------------------------------------- 갱신 */

/**
 * 상태 갱신이자 heartbeat다. 호출할 때마다 마지막활동시간을 서버 시각으로 찍는다.
 *
 * - status가 "작업중"이고 (기록이 없거나 직전 상태가 작업중이 아니었으면) 새 작업의
 *   시작으로 보고 작업시작시간을 지금으로 찍는다. 같은 작업 도중의 heartbeat(=status
 *   생략 또는 status가 계속 작업중)는 시작시간을 건드리지 않는다.
 * - status가 대기/완료/오류·중단이면 종료시각을 지금으로 찍는다(작업중은 아직 안 끝난 것).
 */
export async function upsertAgentStatus(input = {}) {
  const ai = String(input.ai || "").trim();
  if (!ai) throw new ApiError(400, "invalid_request", "ai(AI 이름)가 필요합니다");

  if (input.status !== undefined && !STATES.includes(input.status)) {
    throw new ApiError(400, "unknown_status",
      "실행상태는 다음 중 하나여야 합니다: " + STATES.join(", "));
  }

  const { ref, props, map } = await agentStatusSource();
  const page = await querySource(ref, {
    filter: { property: map.ai, title: { equals: ai } },
    pageSize: 1
  });
  const existing = (page.results || [])[0] || null;
  const existingRecord = existing ? toRecord(existing, map) : null;

  if (!existing && input.status === undefined) {
    throw new ApiError(404, "agent_status_not_found",
      "「" + ai + "」의 실행상태 기록이 아직 없습니다. 처음에는 status를 함께 보내 생성하세요.");
  }

  const now = new Date().toISOString();
  const properties = {};

  properties[map.ai] = encode(props[map.ai], ai);
  // heartbeat의 핵심: 호출될 때마다 서버 시각으로 마지막활동시간을 찍는다.
  if (map.lastActivity) properties[map.lastActivity] = encode(props[map.lastActivity], now);

  if (input.status !== undefined && map.status) {
    properties[map.status] = encode(props[map.status], input.status);

    if (input.status === STATE_WORKING) {
      const wasWorking = existingRecord && existingRecord.status === STATE_WORKING;
      if (!wasWorking && map.startedAt) {
        properties[map.startedAt] = encode(props[map.startedAt], now);
      }
    } else if (END_STATES.has(input.status) && map.endedAt) {
      properties[map.endedAt] = encode(props[map.endedAt], now);
    }
  }

  if (input.taskName !== undefined && map.taskName) {
    properties[map.taskName] = encode(props[map.taskName], String(input.taskName).slice(0, 2000));
  }
  if (input.sessionId !== undefined && map.sessionId) {
    properties[map.sessionId] = encode(props[map.sessionId], String(input.sessionId));
  }
  if (input.pid !== undefined && map.pid) {
    properties[map.pid] = encode(props[map.pid], String(input.pid));
  }
  if (input.note !== undefined && map.note) {
    properties[map.note] = encode(props[map.note], String(input.note).slice(0, 2000));
  }
  if (input.startedAt !== undefined && map.startedAt) {
    properties[map.startedAt] = encode(props[map.startedAt], input.startedAt);
  }

  const savedPage = existing
    ? await updatePageIn(ref, existing.id, properties)
    : await createPageIn(ref, properties);

  const staleSeconds = Number(input.staleSeconds) || DEFAULT_STALE_SECONDS;
  return {
    ok: true,
    created: !existing,
    status: judge(toRecord(savedPage, map), staleSeconds)
  };
}

export async function getAgentStatusSchema() {
  const { ref, props, map, title } = await agentStatusSource();
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
    states: STATES,
    staleThresholdSeconds: DEFAULT_STALE_SECONDS,
    properties
  };
}
