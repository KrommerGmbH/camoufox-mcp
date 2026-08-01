import type { Locator, Page } from 'playwright-core';
import { contentTarget, type Target } from './frame.js';
import { locate } from './locate.js';
import { snapshot } from './snapshot.js';

/**
 * **"하고 · 확인하고 · 안 되면 알린다"** 를 한 번에 하는 실행기.
 *
 * 왜 필요한가 (2026-08-01):
 * DB(`cmh_ai_element`)에 저장된 선택자는 **조사한 그 시점의 사진**입니다. 네이버가 화면을 바꾸면 어긋나고,
 * 한 번 클릭하면 class 가 바뀌어서 못 쓰게 되는 것도 있었습니다(ng-pristine → ng-dirty).
 * 그런데 예전 도구는 이런 때 **조용히 첫 번째를 누르고 "눌렀다"고 답했습니다.**
 * 엉뚱한 것을 눌러 놓고 성공했다고 말하는 것이 제일 위험합니다.
 *
 * 그래서 여기서는 세 가지를 지킵니다.
 *  1. **여러 개가 걸리면 멈춥니다.** 골라서 누르지 않습니다(Playwright 의 strict 규칙과 같은 뜻).
 *  2. **하고 나서 결과를 확인합니다.** 팝업이 닫혔나 · 주소가 바뀌었나 · 글자가 떴나.
 *  3. **안 되면 왜 안 됐는지와 지금 화면의 후보를 조금만** 돌려줍니다. 그 다음은 AI 가 정합니다.
 */

/** 하고 나서 이렇게 되어야 한다 — 이것이 안 맞으면 실패로 봅니다. */
export interface Expect {
  /** 이 글자가 화면에서 사라져야 합니다 (팝업 닫기 · 알림창 닫기) */
  gone?: string;
  /** 이 글자가 화면에 나타나야 합니다 (팝업 열기 · "저장되었습니다") */
  appears?: string;
  /** 주소가 바뀌어야 합니다 (페이지 이동) */
  urlChanged?: boolean;
  /** 체크 상태가 이렇게 되어야 합니다 */
  checked?: boolean;
  /** 입력칸 값이 이렇게 되어야 합니다 */
  value?: string;
  /** 확인까지 기다릴 시간(ms). 기본 8초 */
  timeoutMs?: number;
}

export interface ActPlan {
  do: 'click' | 'type';
  /** DB 가 준 선택자 후보. 1순위부터 넣습니다. 하나씩 써 보고 되는 것을 씁니다. */
  selectors?: string[];
  /** 선택자가 없거나 다 안 될 때 쓸 **글자** */
  text?: string;
  /** do:'type' 일 때 넣을 값 */
  value?: string;
  expect?: Expect;
}

export interface ActResult {
  ok: boolean;
  /** 어디까지 갔다가 멈췄나: 찾기 · 실행 · 확인 */
  단계?: '찾기' | '실행' | '확인';
  /** 실제로 쓴 선택자(또는 글자). 다음에 DB 에 넣을 값입니다. */
  쓴것?: string;
  이유?: string;
  기대?: string;
  실제?: string;
  url: string;
  /** 실패했을 때만. 지금 화면에서 비슷한 것 몇 개. AI 가 고칠 때 씁니다. */
  후보?: unknown[];
}

/** 바깥 문서와 iframe 안쪽 둘 다. 네이버는 화면이 통째로 iframe 안인 곳이 많습니다. */
async function targets(page: Page): Promise<{ t: Target; inFrame: boolean }[]> {
  const frame = await contentTarget(page);
  const list = [{ t: page as Target, inFrame: false }];
  if (frame.inFrame) list.push({ t: frame.target, inFrame: true });
  return list;
}

/** 눈에 보이는 것만 셉니다. 화면에 안 보이는 것은 누를 수 없으니 후보가 아닙니다. */
async function countVisible(loc: Locator): Promise<Locator[]> {
  const total = await loc.count().catch(() => 0);
  const out: Locator[] = [];
  for (let i = 0; i < Math.min(total, 20); i++) {
    const one = loc.nth(i);
    if (await one.isVisible().catch(() => false)) out.push(one);
  }
  return out;
}

/**
 * 선택자 후보를 1순위부터 써 봅니다.
 *
 * **딱 하나 걸린 것만 씁니다.** 두 개 이상 걸리면 그 후보는 버리고 다음 후보로 갑니다.
 * 여러 개 중에 하나를 고르는 것은 찍는 것이고, 찍으면 엉뚱한 것을 누릅니다.
 */
async function bySelectors(
  page: Page,
  selectors: string[],
): Promise<{ el: Locator; used: string } | { 겹침: { selector: string; 개수: number }[] }> {
  const 겹침: { selector: string; 개수: number }[] = [];
  for (const sel of selectors) {
    for (const { t } of await targets(page)) {
      const hits = await countVisible(t.locator(sel)).catch(() => []);
      if (hits.length === 1) return { el: hits[0], used: sel };
      if (hits.length > 1) 겹침.push({ selector: sel, 개수: hits.length });
    }
  }
  return { 겹침 };
}

/** 실패했을 때 AI 에게 줄 힌트. **화면 전체가 아니라 비슷한 것 몇 개만** 줍니다. */
async function hint(page: Page, needle?: string): Promise<unknown[]> {
  if (!needle) return [];
  const snap = await snapshot(page, { find: needle.slice(0, 6), limit: 8 }).catch(() => null);
  return (snap?.elements ?? []).map((e) => ({
    tag: e.tag,
    name: e.name,
    nth: e.nth,
    selector: e.selectors[0]?.expression,
  }));
}

/** 기대한 결과가 됐는지 확인합니다. 안 되면 왜 안 됐는지 글로 돌려줍니다. */
async function verify(page: Page, exp: Expect, urlBefore: string, el: Locator): Promise<string | null> {
  const timeout = exp.timeoutMs ?? 8_000;

  if (exp.gone) {
    for (const { t } of await targets(page)) {
      const ok = await t
        .getByText(exp.gone, { exact: false })
        .first()
        .waitFor({ state: 'hidden', timeout })
        .then(() => true)
        .catch(() => false);
      if (ok) return null;
    }
    return `"${exp.gone}" 가 아직 화면에 있습니다`;
  }

  if (exp.appears) {
    for (const { t } of await targets(page)) {
      const ok = await t
        .getByText(exp.appears, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
      if (ok) return null;
    }
    return `"${exp.appears}" 가 화면에 안 나타났습니다`;
  }

  if (exp.urlChanged) {
    const ok = await page
      .waitForFunction((before) => location.href !== before, urlBefore, { timeout })
      .then(() => true)
      .catch(() => false);
    return ok ? null : `주소가 그대로입니다 (${urlBefore})`;
  }

  if (exp.checked !== undefined) {
    const now = await el.isChecked().catch(() => null);
    return now === exp.checked ? null : `체크 상태가 ${now} 입니다 (${exp.checked} 이어야 함)`;
  }

  if (exp.value !== undefined) {
    const now = await el.inputValue().catch(() => null);
    return now === exp.value ? null : `칸의 값이 "${now}" 입니다 ("${exp.value}" 이어야 함)`;
  }

  return null;
}

export async function act(page: Page, plan: ActPlan): Promise<ActResult> {
  const urlBefore = page.url();
  const needle = plan.text ?? plan.selectors?.[0];

  // ── ① 찾기 ─────────────────────────────────────────────────────────────
  let el: Locator | null = null;
  let used = '';
  let 겹침목록: { selector: string; 개수: number }[] = [];

  if (plan.selectors?.length) {
    const r = await bySelectors(page, plan.selectors);
    if ('el' in r) {
      el = r.el;
      used = r.used;
    } else {
      겹침목록 = r.겹침;
    }
  }

  if (!el && plan.text) {
    const found = await locate(page, { text: plan.text }).catch(() => null);
    // locate 는 여러 개면 첫 번째를 주므로, 여기서 다시 막습니다.
    if (found && found.matches === 1) {
      el = found.locator;
      used = `글자:${plan.text} (${found.how})`;
    } else if (found) {
      겹침목록.push({ selector: `글자:${plan.text}`, 개수: found.matches });
    }
  }

  if (!el) {
    const 겹쳤나 = 겹침목록.length > 0;
    return {
      ok: false,
      단계: '찾기',
      이유: 겹쳤나
        ? `여러 개가 걸려서 안 눌렀습니다: ${겹침목록.map((c) => `${c.selector} → ${c.개수}개`).join(' · ')}. ` +
          '어느 것인지 정해서 다시 부르세요. 찍어서 누르면 엉뚱한 것을 누릅니다.'
        : '선택자로도 글자로도 못 찾았습니다. 화면이 바뀌었을 수 있습니다.',
      url: urlBefore,
      후보: await hint(page, needle),
    };
  }

  // ── ② 실행 ─────────────────────────────────────────────────────────────
  // 사람처럼 움직이는 마우스는 한 번 누르는 데 1~5초가 걸립니다. 짧게 끊으면 멀쩡한 클릭이 죽습니다.
  const CLICK_MS = 20_000;
  try {
    if (plan.do === 'type') {
      await el.click({ timeout: CLICK_MS });
      await el.fill('');
      for (const ch of plan.value ?? '') {
        await el.pressSequentially(ch, { delay: 60 + Math.floor(Math.random() * 80) });
      }
    } else {
      await el.click({ timeout: CLICK_MS });
    }
  } catch (e) {
    // 화면을 계속 다시 그리는 사이트에서는 안전장치가 안 풀립니다. **요소를 집은 채로** 한 번 더 시도합니다.
    await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    const retried = await el
      .click({ force: true, timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!retried) {
      return {
        ok: false,
        단계: '실행',
        쓴것: used,
        이유: String(e).split('\n')[0],
        url: page.url(),
        후보: await hint(page, needle),
      };
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  // ── ③ 확인 ─────────────────────────────────────────────────────────────
  if (plan.expect) {
    const bad = await verify(page, plan.expect, urlBefore, el);
    if (bad) {
      return {
        ok: false,
        단계: '확인',
        쓴것: used,
        이유: '눌렀지만 기대한 결과가 아닙니다.',
        기대: JSON.stringify(plan.expect),
        실제: bad,
        url: page.url(),
        후보: await hint(page, plan.expect.gone ?? plan.expect.appears ?? needle),
      };
    }
  }

  return { ok: true, 쓴것: used, url: page.url() };
}
