import { createHash, timingSafeEqual } from 'node:crypto';

const origin = 'https://woos-dad-dashboard.vercel.app';
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = text => createHash('sha256').update(text).digest('hex');
const clean = value => typeof value === 'string' ? value.trim() : '';
const decisionPending = task => task.아빠개입 === '의사결정' && task.상태 !== '완료';
const revisionFor = task => sha(JSON.stringify([clean(task.개입요청내용), clean(task.결정사항)]));

export function optionsFor(request) {
  const marks = [...request.matchAll(/(?:^|[\s:：/])(?:([1-9])\s*(?:번\s*[.)：:]?|[.)：:])|([①②③④⑤⑥⑦⑧⑨]))\s*/g)];
  if (marks.length) {
    const circled = '①②③④⑤⑥⑦⑧⑨';
    const numbers = marks.map(m => m[1] ? Number(m[1]) : circled.indexOf(m[2]) + 1);
    const labels = marks.map((m, i) => request.slice(m.index + m[0].length, marks[i + 1]?.index ?? request.length).trim());
    return labels.length >= 2 && numbers.every((n, i) => n === i + 1 && labels[i]) ? labels : [];
  }
  if (/(?:승인\s*(?:필요|여부)|(?:반영|배포|머지|진행)\s*(?:\([^\n)]*\))?\s*여부|승인해\s*주세요)/.test(request)) {
    return ['원장에 적힌 요청대로 진행 승인', '승인 보류'];
  }
  return [];
}

function view(task, detail = false) {
  const match = clean(task.작업명).match(/^\[([^\]]+)\]\s*(.+)$/s);
  const ask = clean(task.개입요청내용);
  const pending = decisionPending(task);
  return {
    id: task.id, project: clean(task.프로젝트명) || match?.[1] || '프로젝트 미지정',
    title: match?.[2] || clean(task.작업명), state: task.상태, pending,
    ask: pending || task.아빠개입 === '직접조작' ? ask : '',
    ...(detail && {
      choices: pending ? optionsFor(ask) : [],
      revision: revisionFor(task), details: clean(task.작업내용), decision: clean(task.결정사항),
    }),
  };
}

async function memoryHub(name, args) {
  const key = process.env.TASK_LEDGER_MCP_KEY || process.env.MEMORYHUB_MCP_KEY ||
    (process.env.MEMORYHUB_MCP_KEYS || '').split(',').map(x => x.slice(x.indexOf(':') + 1).trim()).find(x => x.length >= 32);
  if (!key) throw new Error('메모리허브 인증 미설정');
  const response = await fetch(origin + '/api/memoryhub', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(16000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error('메모리허브 응답 실패: ' + response.status);
  const payload = await response.json();
  if (payload.error || payload.result?.isError) throw new Error('메모리허브 처리 실패');
  return JSON.parse(payload.result.content[0].text);
}

export function ledgerHandler(call = memoryHub) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const secret = process.env.DASHBOARD_PASSWORD;
    const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)dash=([0-9a-f]{64})(?:;|$)/)?.[1];
    if (!secret || !cookie || !timingSafeEqual(Buffer.from(cookie), Buffer.from(sha(secret + ':woos-dad-dashboard')))) {
      return res.status(401).json({ error: '기존 대시보드 비밀번호로 로그인해 주세요.' });
    }
    const id = req.query?.id;
    if (id !== undefined && (typeof id !== 'string' || !idPattern.test(id))) return res.status(400).json({ error: '작업 번호가 올바르지 않습니다.' });
    try {
      if (req.method === 'GET') {
        if (id) {
          const task = await call('task_get', { id });
          if (task.in_trash) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
          return res.json(view(task, true));
        }
        const { tasks } = await call('task_search', { limit: 1000 });
        return res.json({ tasks: tasks.filter(t => !t.in_trash && t.상태 !== '완료').map(t => view(t)) });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
      if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        return res.status(403).json({ error: '이 페이지에서 다시 시도해 주세요.' });
      }
      const { choice, revision } = req.body ?? {};
      if (!id || !Number.isInteger(choice) || choice < 1 || choice > 9 || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) {
        return res.status(400).json({ error: '선택 내용을 다시 확인해 주세요.' });
      }
      const task = await call('task_get', { id });
      const receipt = '[웹 결정 ' + revision.slice(0, 16) + '/' + choice + ']';
      if (!task.in_trash && clean(task.결정사항).includes(receipt)) return res.json({ saved: true, alreadySaved: true });
      const ask = clean(task.개입요청내용);
      const option = optionsFor(ask)[choice - 1];
      if (task.in_trash || !decisionPending(task) || revisionFor(task) !== revision || !option) {
        return res.status(409).json({ error: '원장의 결정 요청이 바뀌었습니다. 상세를 다시 열어 주세요.' });
      }
      const decision = '사장님 선택: ' + choice + '번 ' + option + '\n결정 요청: ' + ask + '\n' + receipt;
      const result = await call('task_update', { id, decision, intervention: { type: '없음' } });
      const saved = await call('task_get', { id });
      if (!result.verified || !clean(saved.결정사항).includes(receipt) || saved.아빠개입 !== '없음' || clean(saved.개입요청내용)) {
        return res.status(502).json({ error: '원장 저장을 확인하지 못했습니다. 상세를 다시 열어 확인해 주세요.' });
      }
      return res.json({ saved: true });
    } catch (error) {
      console.error('작업 원장 연결 실패', error?.message);
      return res.status(502).json({ error: '작업 원장에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };
}

export default ledgerHandler();
