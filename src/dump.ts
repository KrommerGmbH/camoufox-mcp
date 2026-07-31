import fs from 'node:fs';
import path from 'node:path';
import type { ExtractResult } from './extract.js';
import { countLeaks, maskJson } from './mask.js';
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
  snap: SnapResult & {
    /** 내용이 iframe 안에 있었는지. 나중에 조작할 때 어디를 봐야 하는지 알려줍니다. */
    inFrame?: boolean;
    frameUrl?: string | null;
    /** 바깥 문서 요소 수 / iframe 안 요소 수 */
    outerCount?: number;
    frameCount?: number;
  };
  net: NetEntry[];
  /**
   * Playwright 가 만들어주는 화면 구조 요약(YAML).
   * 역할·이름·중첩 관계가 한눈에 들어오고, HTML 원본보다 훨씬 짧습니다.
   * 별도 변환 라이브러리가 필요 없습니다 — Playwright 에 이미 들어 있습니다.
   */
  aria?: string;
  /**
   * 브라우저가 다 그린 HTML 을 cheerio 로 훑은 결과.
   * 화면 글을 마크다운으로 바꾸고, select 선택지·표 머리글을 정확히 뽑아줍니다.
   * 화면 스냅샷(보이는지·클릭되는지)과 서로 보완합니다.
   */
  extract?: ExtractResult;
  /** 개인정보(고객 이름·주소·전화)를 가리고 저장할지. 주문·문의 화면은 반드시 켜세요. */
  maskPii?: boolean;
}

/**
 * 조사 결과를 두 벌로 남깁니다.
 *  - .json : 나중에 DB 에 그대로 밀어넣을 원본
 *  - .md   : 사람이 읽고 같이 검토할 문서
 */
export function writeDump(input: DumpInput): { json: string; md: string; leaks: number; leakKeys: string[] } {
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
    // iframe 정보. 이걸 안 남기면 나중에 "이 화면은 어디를 봐야 하나"를 다시 조사해야 합니다.
    inFrame: input.snap.inFrame ?? false,
    frameUrl: input.snap.frameUrl ?? null,
    outerCount: input.snap.outerCount ?? input.snap.elements.length,
    frameCount: input.snap.frameCount ?? 0,
    aria: input.aria ?? null,
    content: input.extract?.markdown ?? null,
    staticFields: input.extract?.fields ?? [],
    staticTables: input.extract?.tables ?? [],
    links: input.extract?.links ?? [],
    extractStats: input.extract?.stats ?? null,
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

  // 주문·문의 화면에는 고객 이름·주소·전화번호가 들어 있습니다.
  // 우리에게 필요한 건 "어떤 칸이 있는가" 이지 그 값이 아니므로, 값만 가리고 구조는 남깁니다.
  let finalPayload = payload;
  if (input.maskPii) {
    // 고객 자료가 실제로 있는 곳만 가립니다.
    //
    // ⚠️ 예전에는 payload 전체를 maskJson 에 넣었습니다. 그러면 `name` 이라는 이름의
    //    칸을 전부 가려서 **버튼 이름까지 지웠습니다** (실측: "알림" → "**", "네이버" → "네**").
    //    버튼 이름은 화면에 적힌 글자이지 고객 자료가 아닙니다. 지우면 조사 결과가 망가집니다.
    //
    // 그래서 이렇게 나눕니다:
    //  - API 응답  → 칸 이름으로 가림 (여기에 진짜 고객 이름·주소·전화가 있습니다)
    //  - 화면 글·표의 예시 줄 → 통째로 뺌 (칸 이름으로는 한글 이름을 못 잡습니다.
    //    실측: 주문 상세의 "구매자명 | 정명화" 가 그대로 남았습니다)
    //  - 요소·입력칸 지도 → 그대로 둠. 단, 표 칸(gridcell)은 데이터라 이름을 지웁니다.
    finalPayload = {
      ...payload,
      content: null,
      // aria 는 화면에 보이는 글을 통째로 담습니다. 표 안의 고객 이름도 그대로 들어갑니다.
      // (실측: content 를 지웠는데 aria 에 "정명화" 가 남아 있었습니다)
      aria: null,
      staticTables: (payload.staticTables ?? []).map((t) => ({ ...t, sampleRows: [] })),
      tables: (payload.tables ?? []).map((t) => ({ ...t, sampleRow: [] })),
      elements: (payload.elements ?? []).map((e) =>
        e.role === 'gridcell' || e.role === 'cell' ? { ...e, name: undefined, text: undefined } : e,
      ),
      apis: maskJson(payload.apis) as typeof payload.apis,
      piiRedacted: true,
    } as typeof payload;
  }

  // 가린 뒤에 다시 훑습니다. 조용히 안 가려지는 것이 이 파일의 원래 고질병이었습니다.
  const leaks = input.maskPii ? countLeaks(finalPayload) : [];

  fs.writeFileSync(jsonPath, JSON.stringify(finalPayload, null, 2), 'utf8');
  fs.writeFileSync(mdPath, toMarkdown(finalPayload), 'utf8');

  return { json: jsonPath, md: mdPath, leaks: leaks.length, leakKeys: [...new Set(leaks.map((l) => l.key))].slice(0, 10) };
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
  if (p.piiRedacted) L.push('- **개인정보 가림**: 화면 글과 표의 예시 값은 저장하지 않았습니다. 칸 이름만 남겼습니다.');
  if (p.inFrame) L.push(`- **iframe 안에 있음**: 요소 ${p.outerCount}개(바깥) + ${p.frameCount}개(iframe) — 조작할 때 안쪽을 봐야 합니다`);
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

  if (p.content) {
    L.push('## 화면 내용');
    L.push('');
    if (p.extractStats) L.push(`_원본 HTML 대비 ${p.extractStats.dropRatio}_`);
    L.push('');
    L.push(String(p.content).split('\n').slice(0, 300).join('\n'));
    L.push('');
  }

  // 입력칸 지도는 HTML 에서 뽑은 것이 정확합니다.
  // select 선택지가 통째로 들어 있어서, 화면을 눌러보지 않아도 값 목록을 알 수 있습니다.
  if (p.staticFields?.length) {
    L.push('## 입력칸 · 버튼 (HTML 기준)');
    L.push('');
    L.push('| 태그 | name | id | 이름표 | 형식 | 필수 | 선택지 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const f of p.staticFields) {
      const opts = f.options?.length ? `${f.options.length}개` : '';
      L.push(
        `| ${f.tag}${f.type ? `[${f.type}]` : ''} | ${f.name ?? ''} | ${f.id ?? ''} | ${(f.label ?? '').replace(/\|/g, '/')} | ${f.placeholder ?? ''} | ${f.required ? '✔' : ''} | ${opts} |`,
      );
    }
    L.push('');

    const withOpts = p.staticFields.filter((f: any) => f.options?.length);
    if (withOpts.length) {
      L.push('### 선택 상자의 선택지 전부');
      L.push('');
      for (const s of withOpts) {
        L.push(`**${s.label || s.name || s.id || '(이름 없음)'}**`);
        L.push('');
        for (const o of s.options) L.push(`- \`${o.value}\` — ${o.text}`);
        L.push('');
      }
    }
  }

  if (p.staticTables?.length) {
    L.push('## 표 구조');
    L.push('');
    for (const t of p.staticTables) {
      L.push(`### ${t.caption ?? '(제목 없음)'} — ${t.rowCount}줄`);
      L.push('');
      L.push(`| ${t.headers.join(' | ')} |`);
      L.push(`|${t.headers.map(() => '---').join('|')}|`);
      for (const r of t.sampleRows) L.push(`| ${r.join(' | ')} |`);
      L.push('');
    }
  }

  // 표 안의 데이터 칸(gridcell, row)까지 다 적으면 파일의 대부분이 상품 목록 내용으로 찹니다.
  // 그건 조작 대상이 아니라 데이터입니다. 그래서 md 에는 "누를 수 있는 것"만 남기고,
  // 전체 목록은 json 에 그대로 둡니다.
  const CONTROL = new Set(['button', 'input', 'select', 'textarea', 'a']);
  const controls = p.elements.filter((e: any) => CONTROL.has(e.tag) && e.name?.trim());
  const omitted = p.elements.length - controls.length;

  L.push('## 조작할 수 있는 요소');
  L.push('');
  L.push(
    `_전체 ${p.elements.length}개 중 누를 수 있는 ${controls.length}개만 적었습니다. ` +
      `나머지 ${omitted}개(표의 데이터 칸 등)는 \`.json\` 에 있습니다._`,
  );
  L.push('');
  L.push('| ref | 태그 | 이름 | 역할 | 1순위 선택자 |');
  L.push('|---|---|---|---|---|');
  for (const e of controls) {
    const top = e.selectors?.[0];
    L.push(
      `| ${e.ref} | ${e.tag}${e.type ? `[${e.type}]` : ''} | ${(e.name ?? '').replace(/\|/g, '/').slice(0, 60)} | ${e.role ?? ''} | \`${top ? `${top.strategy}: ${top.expression}` : ''}\` |`,
    );
  }
  L.push('');

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
