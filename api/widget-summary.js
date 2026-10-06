// 구형 대시보드 전용 엔드포인트 — 2026-10-07 작업 원장 연결 해제.
// widget-summary.js은(는) 더 이상 Notion을 호출하지 않는다(작업 원장 조회·수정 0회).
// 작업 원장의 정본은 메모리허브 MCP(/api/memoryhub)이며 이 엔드포인트와 무관하다.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(410).json({ ok: false, error: "disconnected", message: "구형 대시보드의 작업 원장 연결이 해제되었습니다." });
}
