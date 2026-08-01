import type { Locator, Page } from 'playwright-core';
import { contentTarget, type Target } from './frame.js';

/**
 * **화면을 통째로 받지 않고** 요소 하나를 집습니다.
 *
 * 왜 필요한가 (2026-07-31 실측):
 * 예전에는 누르려면 `browser_snapshot` 을 먼저 불러야 했습니다. 그런데 스냅샷은
 * 요소 400개를 선택자까지 붙여 통째로 돌려줍니다 — **한 번에 150KB**.
 * 버튼 하나 누르자고 그걸 열 번 받았습니다.
 *
 * 여기서는 "저장하기" 같은 **글자만** 받아서 브라우저 쪽에서 찾습니다.
 * 오가는 것은 몇 백 바이트입니다. AI 는 "무엇을 누를지"만 정하고,
 * **찾는 일은 기계가** 합니다.
 */

export interface Found {
  locator: Locator;
  /** 어떻게 찾았는지. 나중에 왜 엉뚱한 걸 눌렀는지 볼 때 씁니다. */
  how: string;
  /** 바깥 문서인지 iframe 안쪽인지 */
  inFrame: boolean;
  /**
   * 같은 조건에 **눈에 보이는 요소가 몇 개** 걸렸는지.
   * 2 이상이면 그중 nth 번째(기본 0번째)를 눌렀다는 뜻입니다. 엉뚱한 것을 눌렀을 수 있으니
   * 부른 쪽에서 사람에게 알려야 합니다.
   */
  matches: number;
}

/** 찾는 순서. 위에 있을수록 뜻이 분명해서 잘 안 깨집니다. */
type Way = { how: string; make: (t: Target, q: string) => Locator };

const WAYS: Way[] = [
  { how: 'role=button', make: (t, q) => t.getByRole('button', { name: q, exact: true }) },
  { how: 'role=link', make: (t, q) => t.getByRole('link', { name: q, exact: true }) },
  { how: 'label', make: (t, q) => t.getByLabel(q, { exact: true }) },
  { how: 'placeholder', make: (t, q) => t.getByPlaceholder(q, { exact: true }) },
  // 여기부터는 부분 일치. 위에서 못 찾았을 때만 씁니다.
  { how: 'role=button(부분)', make: (t, q) => t.getByRole('button', { name: q }) },
  { how: 'role=checkbox', make: (t, q) => t.getByRole('checkbox', { name: q }) },
  { how: 'role=radio', make: (t, q) => t.getByRole('radio', { name: q }) },
  { how: 'label(부분)', make: (t, q) => t.getByLabel(q) },
  { how: 'placeholder(부분)', make: (t, q) => t.getByPlaceholder(q) },
  { how: 'text', make: (t, q) => t.getByText(q, { exact: false }) },
];

/**
 * 눈에 보이는 것 중 nth 번째를 돌려주고, **몇 개가 걸렸는지도 같이** 돌려줍니다.
 * 안 보이는 것은 세지 않습니다.
 *
 * 개수를 같이 주는 이유: 같은 글자를 가진 버튼이 두 개인 화면에서 그냥 첫 번째를 눌러 버리면
 * 엉뚱한 것을 눌러 놓고도 "눌렀다"고 답하게 됩니다. 개수를 알려야 사람이 알아챌 수 있습니다.
 */
async function pickVisible(loc: Locator, nth: number): Promise<{ one: Locator; visible: number } | null> {
  const total = await loc.count().catch(() => 0);
  const seen: Locator[] = [];
  for (let i = 0; i < Math.min(total, 40); i++) {
    const one = loc.nth(i);
    if (await one.isVisible().catch(() => false)) seen.push(one);
  }
  return seen[nth] ? { one: seen[nth], visible: seen.length } : null;
}

export interface LocateQuery {
  /** snapshot 이 준 ref. 있으면 이것만 씁니다(예전 방식 그대로 됩니다). */
  ref?: string;
  /** 버튼·링크·입력칸의 **글자**. 이게 제일 흔한 길입니다. */
  text?: string;
  /** CSS 선택자를 직접 줄 때 */
  selector?: string;
  /** 같은 글자가 여러 개일 때 몇 번째인가 (0부터) */
  nth?: number;
}

/**
 * 바깥 문서와 iframe 안쪽을 **둘 다** 뒤집니다.
 * 네이버는 판매관리·정산 화면이 통째로 iframe 안이라, 한쪽만 보면 못 찾습니다.
 */
export async function locate(page: Page, q: LocateQuery): Promise<Found> {
  const frame = await contentTarget(page);
  const targets: { t: Target; inFrame: boolean }[] = [{ t: page, inFrame: false }];
  if (frame.inFrame) targets.push({ t: frame.target, inFrame: true });

  const nth = q.nth ?? 0;

  // ① ref — 예전 방식. 스냅샷을 이미 받았을 때 제일 정확합니다.
  if (q.ref) {
    const t = q.ref.startsWith('f') && frame.inFrame ? frame.target : page;
    return {
      locator: t.locator(`[data-cfx-ref="${q.ref}"]`),
      how: `ref=${q.ref}`,
      inFrame: q.ref.startsWith('f'),
      matches: 1, // ref 는 요소 하나에만 찍혀 있어서 겹칠 수가 없습니다.
    };
  }

  // ② selector — 사람이 정확히 아는 경우.
  if (q.selector) {
    for (const { t, inFrame } of targets) {
      const hit = await pickVisible(t.locator(q.selector), nth);
      if (hit) {
        return { locator: hit.one, how: `selector${inFrame ? '(iframe)' : ''}`, inFrame, matches: hit.visible };
      }
    }
    throw new Error(`선택자로 못 찾았습니다: ${q.selector}`);
  }

  // ③ 글자 — 제일 흔한 길. 위 순서대로 찾다가 처음 걸리는 것을 씁니다.
  if (q.text) {
    for (const way of WAYS) {
      for (const { t, inFrame } of targets) {
        const hit = await pickVisible(way.make(t, q.text), nth).catch(() => null);
        if (hit) {
          return { locator: hit.one, how: `${way.how}${inFrame ? '(iframe)' : ''}`, inFrame, matches: hit.visible };
        }
      }
    }
    throw new Error(
      `"${q.text}" 를 화면에서 못 찾았습니다. browser_snapshot({find:"${q.text.slice(0, 6)}"}) 로 뭐가 있는지 보세요.`,
    );
  }

  throw new Error('ref · text · selector 중 하나는 주어야 합니다.');
}
