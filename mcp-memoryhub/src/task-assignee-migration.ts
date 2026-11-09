import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { api } from "./notion.js";
import { audit } from "./core.js";

const databaseId = "3c82d174-b03c-81fd-8802-e661400a4f53";
const sourceId = "8ba2d174-b03c-8369-b0a2-07b234b93430";
const path = `/data_sources/${sourceId}`;
const oldName = "담당자";
const newName = "담당자(작업자)";
const legacyName = "작업자 (현재 안씀)";
const employeeSourceId = "3ad01af5-b966-48a4-95da-92b53a5c1c18";

async function snapshot(includeLegacy: boolean) {
  const rows: Record<string, { relation: string[]; legacy?: unknown }> = {};
  let cursor: string | undefined;
  do {
    const result = await api("POST", `${path}/query?filter_properties=koig${includeLegacy ? "&filter_properties=iOL%3D" : ""}`, {
      page_size: 100, ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of result.results) {
      const properties = Object.values<any>(page.properties);
      const relation = properties.find((property) => property.id === "koig");
      const legacy = properties.find((property) => property.id === "iOL%3D");
      if (page.id in rows || !relation || relation.has_more || (includeLegacy && !legacy))
        throw new Error("중복 페이지, 누락된 속성 또는 잘린 관계가 있어 작업을 중지했습니다.");
      rows[page.id] = {
        relation: relation.relation.map((entry: { id: string }) => entry.id).sort(),
        ...(includeLegacy ? { legacy: legacy.select } : {}),
      };
    }
    if (result.has_more && (!result.next_cursor || result.next_cursor === cursor)) throw new Error("조회 커서가 잘렸습니다.");
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  if (!Object.keys(rows).length) throw new Error("작업 원장이 비어 있습니다.");
  return rows;
}

export async function migrateTaskAssignee(a: {
  action: "rename" | "remove_legacy"; backup_sha256: string; dad_instruction: string;
}) {
  const backupFile = process.env.WOOS_TASK_ASSIGNEE_MIGRATION_BACKUP;
  if (!backupFile || process.env.VERCEL) throw new Error("이 작업은 전용 로컬 메모리허브에서만 허용됩니다.");
  if (![legacyName, newName].every((name) => a.dad_instruction.includes(name)))
    throw new Error("두 속성을 명시한 사장님의 실제 지시가 필요합니다.");
  const bytes = readFileSync(backupFile);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== a.backup_sha256.toLowerCase()) throw new Error("백업의 해시가 일치하지 않습니다.");
  const backup = JSON.parse(bytes.toString("utf8"));
  if (backup.database_id !== databaseId || !Array.isArray(backup.rows)) throw new Error("공식 작업 원장 백업이 아닙니다.");

  const before = await api("GET", path);
  const expected = a.action === "rename" ? oldName : newName;
  const relation = before.properties[expected];
  if (before.parent?.database_id !== databaseId || relation?.id !== "koig" || relation.type !== "relation"
      || relation.relation.data_source_id !== employeeSourceId || before.properties[legacyName]?.id !== "iOL%3D"
      || before.properties[legacyName]?.type !== "select" || (a.action === "rename" && before.properties[newName]))
    throw new Error("현재 속성 정의가 승인된 작업 범위와 일치하지 않습니다.");

  const rows = await snapshot(true);
  const saved = new Map(backup.rows.map((row: any) => [row.id, row]));
  if (saved.size !== backup.rows.length || saved.size !== Object.keys(rows).length)
    throw new Error("현재 작업 페이지 목록이 백업과 다릅니다. 다시 백업해야 합니다.");
  for (const [id, row] of Object.entries(rows)) {
    const prior: any = saved.get(id);
    if (!prior || prior.more || JSON.stringify(row.relation) !== JSON.stringify(prior.relation?.slice().sort())
        || JSON.stringify(row.legacy) !== JSON.stringify(prior.legacy))
      throw new Error("관계 또는 예전 작업자 값이 백업과 다릅니다. 다시 백업해야 합니다.");
  }

  const renaming = a.action === "rename";
  await api("PATCH", path, { properties: renaming ? { [oldName]: { name: newName } } : { [legacyName]: null } });
  audit({ tool: "task_assignee_schema_migrate", action: a.action, id: sourceId, backup_sha256: hash, dad_instruction: a.dad_instruction });
  const after = await api("GET", path);
  const actualRows = await snapshot(renaming);
  const expectedProperties = Object.entries<any>(before.properties)
    .filter(([name]) => renaming || name !== legacyName)
    .map(([name, property]) => renaming && name === oldName ? [newName, { ...property, name: newName }] : [name, property]);
  const schemaMatches = Object.keys(after.properties).length === expectedProperties.length
    && expectedProperties.every(([name, property]) => JSON.stringify(after.properties[name]) === JSON.stringify(property));
  const rowsMatch = Object.keys(actualRows).length === Object.keys(rows).length && Object.entries(rows).every(([id, row]) =>
    JSON.stringify(actualRows[id]?.relation) === JSON.stringify(row.relation)
    && (!renaming || JSON.stringify(actualRows[id]?.legacy) === JSON.stringify(row.legacy)));
  return { verified: schemaMatches && rowsMatch, schema_matches: schemaMatches, rows_match: rowsMatch, pages: Object.keys(rows).length };
}
