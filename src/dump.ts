import fs from 'node:fs';
import path from 'node:path';
import type { NetEntry } from './network.js';
import type { SnapResult } from './snapshot.js';

export function outDir(): string {
  return process.env.CAMOUFOX_MCP_OUT ?? path.resolve(process.cwd(), 'inspection');
}

/**
 * menuKey 는 AI 가 지어내는 값이라 그대로 파일 이름에 쓰면 안 됩니다.
 * "../../.ssh/id_rsa" 같은 값이 오면 저장 폴더 밖에 파일을 씁니다.
 * 그래서 영문·숫자·`-`·`_` 만 남기고 전부 자릅니다.
 */
export function safeKey(menuKey: string): string {
  const cleaned = menuKey.trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 64);
  if (!cleaned || /^-+$/.test(cleaned)) {
    throw new Error(`menuKey 가 이상합니다: "${menuKey}". 영문·숫자·-·_ 만 쓰세요 (예: product-list)`);
  }
  return cleaned;
}

export interface DumpInput {
  menuKey: string;
  menuPath?: string;
  note?: string;
  snap: SnapResult;
  net: NetEntry[];
}

/**
 * 조사 결과를 두 벌로 남깁니다.
 *  - .json : 나중에 DB 에 그대로 밀어넣을 원본
 *  - .md   : 사람이 읽고 같이 검토할 문서
 */
export function writeDump(input: DumpInput): { json: string; md: string } {
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });

  const key = safeKey(input.menuKey);
  const jsonPath = path.join(dir, `${key}.json`);
  const mdPath = path.join(dir, `${key}.md`);

  const payload = {
    menuKey: key,
    menuPath: input.menuPath ?? null,
    note: input.note ?? null,
    url: input.snap.url,
    title: input.snap.title,
    inspectedAt: new Date().toISOString(),
    elements: input.snap.elements,
    tables: input.snap.tables,
    apis: input.net.map((e) => ({
      method: e.method,
      url: e.url,
      status: e.status,
      bytes: e.bytes,
      sample: e.body ?? null,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(mdPath, toMarkdown(payload), 'utf8');

  return { json: jsonPath, md: mdPath };
}

function toMarkdown(p: ReturnType<typeof Object> & Record<string, any>): string {
  const L: string[] = [];
  L.push(`# ${p.menuPath ?? p.menuKey}`);
  L.push('');
  L.push(`- **menuKey**: \`${p.menuKey}\``);
  L.push(`- **URL**: ${p.url}`);
  L.push(`- **제목**: ${p.title}`);
  L.push(`- **조사 시각**: ${p.inspectedAt}`);
  if (p.note) L.push(`- **메모**: ${p.note}`);
  L.push('');

  L.push('## 화면이 부르는 데이터 (Network JSON)');
  L.push('');
  if (!p.apis.length) {
    L.push('_잡힌 것이 없습니다. 화면에서 검색·조회를 한 번 누른 뒤 다시 뽑으세요._');
  } else {
    L.push('| 메서드 | URL | 상태 | 크기 |');
    L.push('|---|---|---|---|');
    for (const a of p.apis) L.push(`| ${a.method} | \`${a.url}\` | ${a.status} | ${a.bytes} |`);
  }
  L.push('');

  L.push('## 화면 요소');
  L.push('');
  L.push('| ref | 태그 | 이름 | 역할 | 1순위 선택자 |');
  L.push('|---|---|---|---|---|');
  for (const e of p.elements) {
    const top = e.selectors?.[0];
    L.push(
      `| ${e.ref} | ${e.tag}${e.type ? `[${e.type}]` : ''} | ${e.name ?? ''} | ${e.role ?? ''} | \`${top ? `${top.strategy}: ${top.expression}` : ''}\` |`,
    );
  }
  L.push('');

  const selects = p.elements.filter((e: any) => e.options?.length);
  if (selects.length) {
    L.push('## 선택 상자의 선택지');
    L.push('');
    for (const s of selects) {
      L.push(`### ${s.name || s.ref}`);
      L.push('');
      for (const o of s.options) L.push(`- \`${o.value}\` — ${o.text}`);
      L.push('');
    }
  }

  if (p.tables.length) {
    L.push('## 표');
    L.push('');
    for (const t of p.tables) {
      L.push(`### ${t.caption ?? '(제목 없음)'}`);
      L.push('');
      L.push(`- 머리글: ${t.headers.join(' · ')}`);
      if (t.sampleRow.length) L.push(`- 첫 줄 예시: ${t.sampleRow.join(' · ')}`);
      L.push('');
    }
  }

  L.push('## 이 화면에서 할 수 있는 일');
  L.push('');
  L.push('> ⚠️ 아래는 자동으로 못 채웁니다. 사람과 상의해서 직접 적으세요.');
  L.push('> 이게 비어 있으면 나중에 액션 테이블을 못 만들고 다시 조사하게 됩니다.');
  L.push('');
  L.push('| 액션 | 읽기/쓰기 | 승인 필요 | 쓰는 API 또는 요소 | 입력값 |');
  L.push('|---|---|---|---|---|');
  L.push('| | | | | |');
  L.push('');

  return L.join('\n');
}
