// Notion 객체 ↔ 단순 값 / Markdown 변환
import { api, paginate, normId } from "./notion.js";

// ───────── 제목·리치텍스트 ─────────
export const plain = (rt: any[] | undefined): string => (rt || []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");

export function titleOf(obj: any): string {
  if (!obj) return "";
  if (Array.isArray(obj.title)) return plain(obj.title);
  if (obj.properties) {
    const t: any = Object.values(obj.properties).find((p: any) => p.type === "title");
    if (t) return plain(t.title);
  }
  if (obj.type === "child_page") return obj.child_page.title;
  if (obj.type === "child_database") return obj.child_database.title;
  return "";
}

/** 2000자 제한에 맞춰 텍스트를 rich_text 배열로 */
export function rt(text: string): any[] {
  const out: any[] = [];
  const s = text ?? "";
  for (let i = 0; i < s.length; i += 2000) out.push({ type: "text", text: { content: s.slice(i, i + 2000) } });
  return out.length ? out : [];
}

/** 간단한 인라인 마크다운(**굵게**, *기울임*, `코드`, ~~취소~~, [링크](url)) → rich_text */
export function inlineMd(text: string): any[] {
  const out: any[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![*\w])\*([^*\s][^*]*)\*(?!\*))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (content: string, ann: any = {}, link?: string) => {
    for (let i = 0; i < content.length; i += 2000)
      out.push({ type: "text", text: { content: content.slice(i, i + 2000), ...(link ? { link: { url: link } } : {}) }, annotations: ann });
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[2] !== undefined) push(m[2], { bold: true });
    else if (m[3] !== undefined) push(m[3], { code: true });
    else if (m[4] !== undefined) push(m[4], { strikethrough: true });
    else if (m[5] !== undefined) push(m[5], {}, m[6]);
    else if (m[7] !== undefined) push(m[7], { italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

function rtToMd(rtArr: any[]): string {
  return (rtArr || [])
    .map((t) => {
      let s = t.plain_text ?? "";
      if (t.type === "mention") return s;
      const a = t.annotations || {};
      if (a.code) s = "`" + s + "`";
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join("");
}

// ───────── 속성 읽기 ─────────
export async function simplifyProps(page: any, expandRelations = true): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const [name, p] of Object.entries<any>(page.properties || {})) {
    switch (p.type) {
      case "title": case "rich_text": out[name] = plain(p[p.type]); break;
      case "number": case "checkbox": case "url": case "email": case "phone_number": out[name] = p[p.type]; break;
      case "select": case "status": out[name] = p[p.type]?.name ?? null; break;
      case "multi_select": out[name] = p.multi_select.map((o: any) => o.name); break;
      case "date": out[name] = p.date ? (p.date.end ? { start: p.date.start, end: p.date.end } : p.date.start) : null; break;
      case "people": out[name] = p.people.map((u: any) => u.name || u.id); break;
      case "relation": {
        let ids = p.relation.map((r: any) => r.id);
        if (p.has_more && expandRelations) ids = (await paginate("GET", `/pages/${page.id}/properties/${encodeURIComponent(p.id)}`)).map((r: any) => r.relation.id);
        out[name] = ids;
        break;
      }
      case "formula": out[name] = p.formula?.[p.formula?.type] ?? null; break;
      case "rollup": out[name] = p.rollup?.type === "array" ? `(rollup ${p.rollup.array.length}건)` : p.rollup?.[p.rollup?.type] ?? null; break;
      case "created_time": case "last_edited_time": out[name] = p[p.type]; break;
      case "created_by": case "last_edited_by": out[name] = p[p.type]?.name || p[p.type]?.id; break;
      case "files": out[name] = p.files.map((f: any) => f.name); break;
      case "unique_id": out[name] = p.unique_id ? `${p.unique_id.prefix ? p.unique_id.prefix + "-" : ""}${p.unique_id.number}` : null; break;
      default: out[name] = `(${p.type})`;
    }
  }
  return out;
}

// ───────── 속성 쓰기 ─────────
/** 스키마를 보고 단순 값을 Notion 속성 값으로 변환. null = 비우기 */
export function buildProps(schema: Record<string, any>, values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, v] of Object.entries(values)) {
    const def = schema[name];
    if (!def) throw new Error(`속성 "${name}"이(가) 스키마에 없습니다. 있는 속성: ${Object.keys(schema).join(", ")}`);
    const t = def.type;
    if (v && typeof v === "object" && !Array.isArray(v) && v.__raw) { out[name] = v.__raw; continue; }
    switch (t) {
      case "title": out[name] = { title: v == null ? [] : inlineMd(String(v)) }; break;
      case "rich_text": out[name] = { rich_text: v == null ? [] : rt(String(v)) }; break;
      case "number": out[name] = { number: v == null ? null : Number(v) }; break;
      case "checkbox": out[name] = { checkbox: v === true || v === "true" || v === "__YES__" }; break;
      case "url": case "email": case "phone_number": out[name] = { [t]: v == null || v === "" ? null : String(v) }; break;
      case "select": case "status": {
        if (v != null) {
          const opts = (def[t]?.options || []).map((o: any) => o.name);
          if (opts.length && !opts.includes(String(v))) throw new Error(`"${name}"에 없는 값 "${v}". 허용: ${opts.join(" / ")}`);
        }
        out[name] = { [t]: v == null ? null : { name: String(v) } };
        break;
      }
      case "multi_select": {
        const arr = v == null ? [] : Array.isArray(v) ? v : [v];
        out[name] = { multi_select: arr.map((x: any) => ({ name: String(x) })) };
        break;
      }
      case "date": {
        if (v == null) out[name] = { date: null };
        else if (typeof v === "string") out[name] = { date: { start: v } };
        else out[name] = { date: { start: v.start, end: v.end ?? null, ...(v.time_zone ? { time_zone: v.time_zone } : {}) } };
        break;
      }
      case "relation": {
        const arr = v == null ? [] : Array.isArray(v) ? v : [v];
        out[name] = { relation: arr.map((id: string) => ({ id: normId(id) })) };
        break;
      }
      case "people": {
        const arr = v == null ? [] : Array.isArray(v) ? v : [v];
        out[name] = { people: arr.map((id: string) => ({ object: "user", id: normId(id) })) };
        break;
      }
      default:
        throw new Error(`"${name}" (${t}) 속성은 직접 쓸 수 없습니다 (계산형/시스템 속성). 필요하면 {"__raw": {...}} 형태로 Notion 원형 값을 주세요.`);
    }
  }
  return out;
}

// ───────── 스키마 정의(생성·수정용) ─────────
/** "number" | {select:[..]} | {relation:"<ds id>", dual?:true} | {status:[..]} | raw Notion 정의 → Notion 속성 정의 */
export function schemaDef(spec: any): any {
  if (typeof spec === "string") {
    const simple = ["title", "rich_text", "number", "checkbox", "date", "url", "email", "phone_number", "people", "files", "created_time", "last_edited_time", "created_by", "last_edited_by"];
    if (!simple.includes(spec)) throw new Error(`알 수 없는 속성 타입 "${spec}"`);
    return { [spec]: {} };
  }
  if (spec.select) return { select: { options: spec.select.map((n: string) => ({ name: n })) } };
  if (spec.multi_select) return { multi_select: { options: spec.multi_select.map((n: string) => ({ name: n })) } };
  if (spec.relation) {
    const ds = normId(spec.relation);
    return { relation: spec.dual ? { data_source_id: ds, dual_property: {} } : { data_source_id: ds, single_property: {} } };
  }
  return spec; // Notion 원형 정의
}

// ───────── Markdown → blocks ─────────
const LANGS = new Set(["abap","abc","agda","arduino","ascii art","assembly","bash","basic","bnf","c","c#","c++","clojure","coffeescript","coq","css","dart","dhall","diff","docker","ebnf","elixir","elm","erlang","f#","flow","fortran","gherkin","glsl","go","graphql","groovy","haskell","hcl","html","idris","java","javascript","json","julia","kotlin","latex","less","lisp","livescript","llvm ir","lua","makefile","markdown","markup","matlab","mathematica","mermaid","nix","notion formula","objective-c","ocaml","pascal","perl","php","plain text","powershell","prolog","protobuf","purescript","python","r","racket","reason","ruby","rust","sass","scala","scheme","scss","shell","smalltalk","solidity","sql","swift","toml","typescript","vb.net","verilog","vhdl","visual basic","webassembly","xml","yaml","java/c/c++/c#"]);
const LANG_ALIAS: Record<string, string> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "shell", zsh: "shell", ps1: "powershell", yml: "yaml", md: "markdown", text: "plain text", txt: "plain text", "": "plain text", cs: "c#", cpp: "c++", rb: "ruby", kt: "kotlin", rs: "rust", dockerfile: "docker" };
function codeLang(l: string): string { const k = l.toLowerCase(); const v = LANG_ALIAS[k] ?? k; return LANGS.has(v) ? v : "plain text"; }

export function mdToBlocks(md: string): any[] {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const root: any[] = [];
  const stack: { indent: number; children: any[] }[] = [{ indent: -1, children: root }];
  let i = 0;
  const add = (indent: number, block: any) => {
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(block);
    const t = block.type;
    if (["bulleted_list_item", "numbered_list_item", "to_do", "toggle"].includes(t)) {
      block[t].children = [];
      stack.push({ indent, children: block[t].children });
    }
  };
  while (i < lines.length) {
    const raw = lines[i];
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "  ").length;
    const line = raw.trim();
    if (!line) { i++; continue; }
    let m: RegExpMatchArray | null;
    if (line.startsWith("```")) {
      const lang = codeLang(line.slice(3).trim());
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      i++;
      add(indent, { type: "code", code: { language: lang, rich_text: rt(buf.join("\n")) } });
      continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) add(-1, { type: `heading_${m[1].length}`, [`heading_${m[1].length}`]: { rich_text: inlineMd(m[2]) } });
    else if (/^(-{3,}|\*{3,})$/.test(line)) add(-1, { type: "divider", divider: {} });
    else if ((m = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) add(indent, { type: "to_do", to_do: { checked: m[1].toLowerCase() === "x", rich_text: inlineMd(m[2]) } });
    else if ((m = line.match(/^[-*+]\s+(.*)$/))) add(indent, { type: "bulleted_list_item", bulleted_list_item: { rich_text: inlineMd(m[1]) } });
    else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) add(indent, { type: "numbered_list_item", numbered_list_item: { rich_text: inlineMd(m[1]) } });
    else if ((m = line.match(/^>\s?(.*)$/))) add(-1, { type: "quote", quote: { rich_text: inlineMd(m[1]) } });
    else add(indent > 0 ? indent : -1, { type: "paragraph", paragraph: { rich_text: inlineMd(line) } });
    i++;
  }
  // 빈 children 제거
  const clean = (arr: any[]) => arr.forEach((b) => { const c = b[b.type]?.children; if (c) { if (!c.length) delete b[b.type].children; else clean(c); } });
  clean(root);
  return root;
}

/** 블록 append (100개 단위, 중첩 깊이 2 제한을 넘는 부분은 후속 호출로 처리) */
export async function appendBlocks(parentId: string, blocks: any[], after?: string): Promise<string[]> {
  const ids: string[] = [];
  for (let k = 0; k < blocks.length; k += 100) {
    const chunk = blocks.slice(k, k + 100).map(stripDeep);
    const body: any = { children: chunk.map((c) => c.block) };
    if (after) body.after = k === 0 ? after : ids[ids.length - 1];
    const res: any = await api("PATCH", `/blocks/${parentId}/children`, body);
    const created = res.results.slice(-chunk.length);
    for (let j = 0; j < chunk.length; j++) {
      ids.push(created[j].id);
      if (chunk[j].deferred.length) await appendBlocks(created[j].id, chunk[j].deferred);
    }
  }
  return ids;
}
// Notion은 한 요청에서 2단계 중첩까지만 허용 → 1단계 아래 children은 따로 보낸다
function stripDeep(b: any): { block: any; deferred: any[] } {
  const t = b.type;
  const kids = b[t]?.children;
  if (!kids) return { block: b, deferred: [] };
  const copy = { ...b, [t]: { ...b[t] } };
  delete copy[t].children;
  return { block: copy, deferred: kids };
}

// ───────── blocks → Markdown ─────────
export async function blocksToMd(blockId: string, depth = 0, maxDepth = 3, budget = { n: 0, max: 1500 }): Promise<string> {
  const blocks = await paginate("GET", `/blocks/${blockId}/children`, {}, 2000);
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  let num = 0;
  for (const b of blocks) {
    if (budget.n++ >= budget.max) { lines.push(`${pad}…(블록 ${budget.max}개 초과, 생략)`); break; }
    const t = b.type;
    const d = b[t] || {};
    const text = rtToMd(d.rich_text || []);
    num = t === "numbered_list_item" ? num + 1 : 0;
    switch (t) {
      case "paragraph": lines.push(pad + text); break;
      case "heading_1": lines.push(`# ${text}`); break;
      case "heading_2": lines.push(`## ${text}`); break;
      case "heading_3": case "heading_4": lines.push(`### ${text}`); break;
      case "bulleted_list_item": lines.push(`${pad}- ${text}`); break;
      case "numbered_list_item": lines.push(`${pad}${num}. ${text}`); break;
      case "to_do": lines.push(`${pad}- [${d.checked ? "x" : " "}] ${text}`); break;
      case "toggle": lines.push(`${pad}▸ ${text}`); break;
      case "quote": lines.push(`> ${text}`); break;
      case "callout": lines.push(`> ${d.icon?.emoji ?? "💡"} ${text}`); break;
      case "code": lines.push("```" + (d.language || ""), plain(d.rich_text), "```"); break;
      case "divider": lines.push("---"); break;
      case "child_page": lines.push(`${pad}📄 [하위 페이지] ${d.title} (id: ${b.id})`); break;
      case "child_database": lines.push(`${pad}🗂 [하위 DB] ${d.title} (id: ${b.id})`); break;
      case "link_to_page": lines.push(`${pad}🔗 ${d.page_id || d.database_id || ""}`); break;
      case "table": {
        const rows = await paginate("GET", `/blocks/${b.id}/children`);
        rows.forEach((r: any, idx: number) => {
          lines.push("| " + r.table_row.cells.map((c: any) => rtToMd(c).replace(/\|/g, "\\|")).join(" | ") + " |");
          if (idx === 0) lines.push("|" + r.table_row.cells.map(() => " --- ").join("|") + "|");
        });
        break;
      }
      case "bookmark": case "embed": case "link_preview": lines.push(`${pad}${d.url}`); break;
      case "image": case "file": case "pdf": case "video": lines.push(`${pad}[${t}] ${d.external?.url || d.file?.url || ""}`); break;
      case "equation": lines.push(`$$${d.expression}$$`); break;
      case "synced_block": case "column_list": case "column": break;
      case "unsupported": lines.push(`${pad}(지원 안 되는 블록)`); break;
      default: lines.push(`${pad}(${t}) ${text}`);
    }
    if (b.has_children && !["child_page", "child_database", "table"].includes(t)) {
      if (depth < maxDepth) lines.push(await blocksToMd(b.id, ["synced_block", "column_list", "column"].includes(t) ? depth : depth + 1, maxDepth, budget));
      else lines.push(`${pad}  …(하위 블록 생략, id: ${b.id})`);
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}
