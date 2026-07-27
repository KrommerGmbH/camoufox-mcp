import type { Page } from 'playwright-core';

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
}

/**
 * 화면에서 사람이 만질 수 있는 요소를 전부 뽑습니다.
 * 각 요소에 data-cfx-ref 를 찍어두므로, 이후 click/type 이 ref 로 정확히 그 요소를 집습니다.
 * (좌표 클릭을 절대 쓰지 않기 위한 장치입니다.)
 */
export async function snapshot(page: Page, limit = 400): Promise<SnapResult> {
  return page.evaluate(
    ({ max }) => {
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

      for (const el of Array.from(document.querySelectorAll(SEL))) {
        if (n >= max) {
          truncated = true;
          break;
        }
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // 눈에 안 보이는 것은 기록하지 않습니다(숨은 요소까지 담으면 쓸모없이 커집니다).
        if (box.width === 0 || box.height === 0) continue;
        if (style.visibility === 'hidden' || style.display === 'none') continue;

        const ref = `e${++n}`;
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

        const item: SnapElement = { ref, tag, name: name || undefined, selectors };
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

      return { url: location.href, title: document.title, elements, tables, truncated };
    },
    { max: limit },
  );
}

/** ref 로 진짜 요소를 집습니다. 좌표는 절대 쓰지 않습니다. */
export function byRef(page: Page, ref: string) {
  return page.locator(`[data-cfx-ref="${ref}"]`);
}
