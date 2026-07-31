import * as cheerio from 'cheerio';
import { NodeHtmlMarkdown } from 'node-html-markdown';

/**
 * 화면을 "읽기 좋은 글"과 "정적 요소 지도"로 바꿉니다.
 *
 * 브라우저가 다 그린 뒤의 HTML 을 받아서 처리합니다.
 * (주소만 가지고 HTML 을 받아오면 안 됩니다 — 네이버 관리자는 화면을 JS 로 그리기 때문에
 *  껍데기만 옵니다.)
 *
 * 여기서 하는 일과 못 하는 일:
 *  - 할 수 있는 것: 글 내용, 표, 링크, select 의 선택지, 입력칸 이름/형식
 *  - 못 하는 것  : 지금 화면에 보이는지, 클릭이 되는지 → 그건 브라우저 안에서 재야 합니다
 */

const nhm = new NodeHtmlMarkdown({
  keepDataImages: false,
  maxConsecutiveNewlines: 2,
});

/** 글에서 빼야 할 것들. 남기면 마크다운이 쓰레기로 가득 찹니다. */
const DROP = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'link',
  'meta',
  'template',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
];

export interface StaticField {
  /** input / select / textarea / button */
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  /** select 의 선택지 전부 */
  options?: Array<{ value: string; text: string }>;
}

export interface StaticTable {
  caption?: string;
  headers: string[];
  /** 예시 줄 2개까지만. 더 넣으면 파일만 커지고 쓸모가 없습니다. */
  sampleRows: string[][];
  rowCount: number;
}

export interface ExtractResult {
  markdown: string;
  fields: StaticField[];
  tables: StaticTable[];
  /** 화면 안의 링크 (하위 메뉴 찾을 때 씁니다) */
  links: Array<{ text: string; href: string }>;
  stats: { htmlBytes: number; markdownBytes: number; dropRatio: string };
}

/** cheerio 1.2 는 Element 타입을 밖으로 안 내보냅니다. 필요한 만큼만 직접 적습니다. */
type Node = Parameters<cheerio.CheerioAPI>[0] extends infer T ? Extract<T, { tagName?: string }> : never;

/** 입력칸에 붙은 이름표를 찾습니다. for=id → 감싸는 label → 앞의 글자 순서로 봅니다. */
function labelFor($: cheerio.CheerioAPI, el: Node): string | undefined {
  const $el = $(el);
  const id = $el.attr('id');
  // CSS.escape 는 브라우저에만 있는 함수라 Node 에서는 못 씁니다.
  // id 에 따옴표나 역슬래시가 들어간 경우만 막아주면 충분합니다.
  if (id && !/["\\]/.test(id)) {
    const byFor = $(`label[for="${id}"]`).first().text().trim();
    if (byFor) return byFor;
  }
  const wrap = $el.closest('label').first().text().trim();
  if (wrap) return wrap.slice(0, 120);
  const aria = $el.attr('aria-label');
  if (aria) return aria.trim();
  return undefined;
}

export function extractFromHtml(html: string, baseUrl?: string): ExtractResult {
  const $ = cheerio.load(html);

  // 1) 글로 바꾸기 전에 쓰레기를 걷어냅니다.
  for (const sel of DROP) $(sel).remove();

  // 2) 본문 후보를 고릅니다. 없으면 body 전체.
  const mainEl = $('main').first().length
    ? $('main').first()
    : $('[role="main"]').first().length
      ? $('[role="main"]').first()
      : $('body');

  const markdown = nhm.translate(mainEl.html() ?? '').trim();

  // 3) 입력칸 지도 (select 선택지 포함 — 이게 화면 스냅샷보다 훨씬 정확합니다)
  const fields: StaticField[] = [];
  $('input, select, textarea, button').each((_, el) => {
    const $el = $(el);
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? 'input';
    const type = $el.attr('type');
    if (type === 'hidden') return; // 숨은 값은 조작 대상이 아닙니다.

    const f: StaticField = {
      tag,
      type,
      name: $el.attr('name'),
      id: $el.attr('id'),
      label: labelFor($, el),
      placeholder: $el.attr('placeholder'),
      required: $el.attr('required') !== undefined || $el.attr('aria-required') === 'true',
    };
    if (tag === 'button' && !f.label) f.label = $el.text().trim().slice(0, 80) || undefined;

    if (tag === 'select') {
      f.options = $el
        .find('option')
        .toArray()
        .map((o) => ({ value: $(o).attr('value') ?? '', text: $(o).text().trim() }));
    }
    fields.push(f);
  });

  // 4) 표 구조
  const tables: StaticTable[] = [];
  $('table').each((_, el) => {
    const $t = $(el);
    const headers = $t
      .find('thead th, tr:first-child th')
      .toArray()
      .map((h) => $(h).text().trim())
      .filter(Boolean);
    if (!headers.length) return;
    const bodyRows = $t.find('tbody tr').toArray();
    tables.push({
      caption: $t.find('caption').first().text().trim() || undefined,
      headers,
      rowCount: bodyRows.length,
      sampleRows: bodyRows.slice(0, 2).map((r) =>
        $(r)
          .find('td')
          .toArray()
          .map((c) => $(c).text().trim().replace(/\s+/g, ' ').slice(0, 60)),
      ),
    });
  });

  // 5) 링크 (하위 메뉴 발견용)
  const seen = new Set<string>();
  const links: Array<{ text: string; href: string }> = [];
  $('a[href]').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    let href = $(el).attr('href') ?? '';
    if (!text || !href || href.startsWith('javascript:')) return;
    if (baseUrl) {
      try {
        href = new URL(href, baseUrl).toString();
      } catch {
        /* 상대 주소가 이상하면 그대로 둡니다 */
      }
    }
    const key = `${text}|${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text: text.slice(0, 80), href });
  });

  const htmlBytes = Buffer.byteLength(html);
  const markdownBytes = Buffer.byteLength(markdown);
  return {
    markdown,
    fields,
    tables,
    links,
    stats: {
      htmlBytes,
      markdownBytes,
      dropRatio: `${Math.round((1 - markdownBytes / Math.max(htmlBytes, 1)) * 100)}% 줄임`,
    },
  };
}
