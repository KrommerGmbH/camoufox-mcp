import type { Target } from './frame.js';

export interface SnapElement {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  text?: string;
  /** 이 요소를 가리키는 방법들. 위에 있을수록 잘 안 깨집니다. */
  selectors: { strategy: string; expression: string }[];
  /** select 의 선택지 전부. 나중에 다시 조사하지 않으려고 지금 다 담습니다. */
  options?: { value: string; text: string }[];
}

export interface SnapResult {
  url: string;
  title: string;
  elements: SnapElement[];
  tables: { caption?: string; headers: string[]; sampleRow: string[] }[];
  truncated: boolean;
  /** 거르기 전에 화면에 몇 개 있었는지. "덜 받았다"는 것을 알 수 있게 합니다. */
  totalOnScreen?: number;
}

export interface SnapOptions {
  /** 최대 개수 */
  limit?: number;
  /**
   * 이 글자가 든 요소만. **브라우저 안에서 거릅니다** — 안 걸린 것은 아예 안 보냅니다.
   * 이것 하나로 응답이 150KB → 2KB 가 됩니다.
   */
  find?: string;
  /** 종류로 거르기: click(누를 것) · input(값 넣을 것) · all */
  only?: 'click' | 'input' | 'all';
  /** 참이면 선택자를 전부 담습니다. 기본은 위에서 2개만(나머지는 길기만 하고 잘 깨집니다). */
  verbose?: boolean;
}

/**
 * 화면에서 사람이 만질 수 있는 요소를 뽑습니다.
 * 각 요소에 data-cfx-ref 를 찍어두므로, 이후 click/type 이 ref 로 정확히 그 요소를 집습니다.
 *
 * ⚠️ **거르기(`find`·`only`)는 브라우저 안에서 합니다.**
 * 400개를 다 받아서 1개를 고르는 것은 절약이 아닙니다. 기계가 걸러서 1개만 보내는 것이 절약입니다.
 */
export async function snapshot(target: Target, opts: SnapOptions = {}, prefix = 'e'): Promise<SnapResult> {
  return target.evaluate(
    ({ max, pfx, find, only, verbose }) => {
      const CAP = 'data-cfx-ref';
      document.querySelectorAll(`[${CAP}]`).forEach((el) => el.removeAttribute(CAP));

      const cut = (s: string | null | undefined, n = 80) =>
        (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

      const accName = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return cut(aria);
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const t = by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
          if (t.trim()) return cut(t);
        }
        const id = el.getAttribute('id');
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab?.textContent?.trim()) return cut(lab.textContent);
        }
        const wrapLab = el.closest('label');
        if (wrapLab?.textContent?.trim()) return cut(wrapLab.textContent);
        const title = el.getAttribute('title');
        if (title) return cut(title);
        return cut((el as HTMLElement).innerText || el.textContent);
      };

      // 배포마다 바뀌는 자동생성 class 인지 대충 판별합니다 (예: css-1tk4pl9, sc-a1b2c3).
      const generated = (token: string) =>
        /^(css|sc|jsx|emotion|_)[-_]?[0-9a-z]{4,}$/i.test(token) || /^[a-z]{1,3}[0-9]{4,}$/i.test(token);

      const stableClasses = (el: Element) =>
        Array.from(el.classList).filter((c) => !generated(c)).slice(0, 2);

      const cssPath = (el: Element): string => {
        const parts: string[] = [];
        let cur: Element | null = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 6) {
          const id = cur.getAttribute('id');
          if (id && !generated(id)) {
            parts.unshift(`#${CSS.escape(id)}`);
            break;
          }
          let seg = cur.tagName.toLowerCase();
          const cls = stableClasses(cur);
          if (cls.length) seg += cls.map((c) => `.${CSS.escape(c)}`).join('');
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const sibs = Array.from(parent.children).filter((s) => s.tagName === cur!.tagName);
            if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
          }
          parts.unshift(seg);
          cur = parent;
          depth++;
        }
        return parts.join(' > ');
      };

      const SEL =
        'a,button,input,select,textarea,[role],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

      const elements: SnapElement[] = [];
      let n = 0;
      let truncated = false;
      let totalOnScreen = 0;

      const needle = (find ?? '').trim().toLowerCase();
      const CLICKABLE = new Set(['a', 'button']);
      const INPUTS = new Set(['input', 'select', 'textarea']);

      for (const el of Array.from(document.querySelectorAll(SEL))) {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const tagLower = el.tagName.toLowerCase();

        if (style.visibility === 'hidden' || style.display === 'none') continue;

        // 크기가 0 이라고 무조건 버리면 안 됩니다.
        //
        // 실측(2026-07-31, 네이버 상품속성 "연령"): 진짜 체크박스는 크기 0 으로 숨겨 두고
        // 그 위에 예쁜 네모를 그려 놓습니다. 예전 규칙으로는 이 체크박스가 **목록에서 통째로 사라져서**
        // AI 가 누를 방법이 없었습니다. 그래서 **감싼 라벨이 보이면 살려 둡니다.**
        if (box.width === 0 || box.height === 0) {
          const lab = el.closest('label');
          const labBox = lab?.getBoundingClientRect();
          if (!labBox || labBox.width === 0 || labBox.height === 0) continue;
        }

        totalOnScreen++;

        // ── 여기서 거릅니다. 걸린 것만 밖으로 나갑니다 ──
        if (only === 'click' && !CLICKABLE.has(tagLower) && el.getAttribute('role') !== 'button') continue;
        if (only === 'input' && !INPUTS.has(tagLower)) continue;
        if (needle) {
          const hay = [
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.getAttribute('id'),
            el.getAttribute('value'),
            (el as HTMLElement).innerText,
            el.closest('label')?.textContent,
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(needle)) continue;
        }

        if (n >= max) {
          truncated = true;
          break;
        }

        const ref = `${pfx}${++n}`;
        el.setAttribute(CAP, ref);

        const tag = el.tagName.toLowerCase();
        const name = accName(el);
        const role = el.getAttribute('role') ?? undefined;
        const placeholder = el.getAttribute('placeholder') ?? undefined;

        const selectors: { strategy: string; expression: string }[] = [];
        for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
          const v = el.getAttribute(a);
          if (v) selectors.push({ strategy: 'testid', expression: `[${a}="${v}"]` });
        }
        const id = el.getAttribute('id');
        if (id && !generated(id)) selectors.push({ strategy: 'css', expression: `#${id}` });
        const nm = el.getAttribute('name');
        if (nm) selectors.push({ strategy: 'css', expression: `${tag}[name="${nm}"]` });
        if (role && name) selectors.push({ strategy: 'role', expression: `${role}|${name}` });
        if (placeholder) selectors.push({ strategy: 'placeholder', expression: placeholder });
        if (name && (tag === 'button' || tag === 'a')) {
          selectors.push({ strategy: 'text', expression: name });
        }
        selectors.push({ strategy: 'css', expression: cssPath(el) });

        // 선택자를 다 보내지 않습니다.
        // 위쪽 두 개가 제일 안 깨지고, 맨 아래 cssPath 는 길기만 하고 배포 때마다 깨집니다.
        // 요소 400개 × 선택자 6개를 보내면 그것만으로 100KB 가 넘습니다.
        const keep = verbose ? selectors : selectors.slice(0, 2);

        const item: SnapElement = { ref, tag, name: name || undefined, selectors: keep };
        if (role) item.role = role;
        if (placeholder) item.placeholder = placeholder;
        const t = el.getAttribute('type');
        if (t) item.type = t;
        if ((el as HTMLInputElement).disabled) item.disabled = true;
        const val = (el as HTMLInputElement).value;
        if (val && tag !== 'select') item.value = cut(val, 40);
        const txt = cut((el as HTMLElement).innerText, 60);
        if (txt && txt !== name) item.text = txt;

        if (tag === 'select') {
          item.options = Array.from((el as HTMLSelectElement).options).map((o) => ({
            value: o.value,
            text: cut(o.textContent, 60),
          }));
        }

        elements.push(item);
      }

      // 표는 머리글과 첫 줄만 봅니다. 어떤 데이터가 있는 화면인지 알기에는 충분합니다.
      const tables = Array.from(document.querySelectorAll('table'))
        .slice(0, 10)
        .map((tb) => ({
          caption: cut(tb.querySelector('caption')?.textContent, 60) || undefined,
          headers: Array.from(tb.querySelectorAll('thead th, tr:first-child th')).map((th) =>
            cut(th.textContent, 40),
          ),
          sampleRow: Array.from(tb.querySelectorAll('tbody tr:first-child td')).map((td) =>
            cut(td.textContent, 40),
          ),
        }))
        .filter((t) => t.headers.length > 0);

      return { url: location.href, title: document.title, elements, tables, truncated, totalOnScreen };
    },
    {
      max: opts.limit ?? 400,
      pfx: prefix,
      find: opts.find ?? '',
      only: opts.only ?? 'all',
      verbose: opts.verbose ?? false,
    },
  );
}

/** ref 로 진짜 요소를 집습니다. 좌표는 절대 쓰지 않습니다. */
export function byRef(target: Target, ref: string) {
  return target.locator(`[data-cfx-ref="${ref}"]`);
}
