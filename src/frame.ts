import type { Frame, Page } from 'playwright-core';
import type { SnapResult } from './snapshot.js';

/**
 * 진짜 내용이 들어 있는 곳을 찾습니다.
 *
 * 네이버 판매관리·정산관리 화면은 `iframe` 안에 통째로 들어 있습니다.
 * 바깥 문서만 보면 왼쪽 메뉴 몇 개(72개)만 보이고 정작 주문 목록은 하나도 안 보입니다.
 * 그래서 화면을 거의 다 덮는 iframe 이 있으면 그 안쪽을 대상으로 삼습니다.
 *
 * Playwright 의 Frame 은 Page 와 같은 방법(evaluate·locator·content)을 쓰므로,
 * 대상만 바꿔 끼우면 나머지 코드는 그대로 돕니다.
 */
export type Target = Page | Frame;

export interface FrameInfo {
  /** 실제로 조사할 대상 */
  target: Target;
  /** iframe 안으로 들어갔는지 */
  inFrame: boolean;
  /** 들어간 iframe 의 주소 */
  frameUrl: string | null;
  /** 화면에 있던 iframe 개수 */
  frameCount: number;
}

/** 화면을 60% 이상 덮는 iframe 이면 "이게 본문"이라고 봅니다. */
const COVER_RATIO = 0.6;

export async function contentTarget(page: Page): Promise<FrameInfo> {
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  if (!frames.length) {
    return { target: page, inFrame: false, frameUrl: null, frameCount: 0 };
  }

  const view = page.viewportSize() ?? { width: 1920, height: 1080 };
  const area = view.width * view.height;

  let best: { frame: Frame; size: number } | null = null;
  for (const f of frames) {
    const el = await f.frameElement().catch(() => null);
    if (!el) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box) continue;
    const size = box.width * box.height;
    if (size / area < COVER_RATIO) continue; // 작은 광고 iframe 은 건너뜁니다.
    if (!best || size > best.size) best = { frame: f, size };
  }

  if (!best) {
    return { target: page, inFrame: false, frameUrl: null, frameCount: frames.length };
  }
  return {
    target: best.frame,
    inFrame: true,
    frameUrl: best.frame.url(),
    frameCount: frames.length,
  };
}

/**
 * 바깥 문서와 iframe 안쪽을 **둘 다** 훑어서 하나로 합칩니다.
 *
 * 왼쪽 메뉴는 바깥에 있고, 주문 목록 같은 내용은 iframe 안에 있습니다.
 * 한쪽만 보면 메뉴를 못 누르거나 내용을 못 읽습니다.
 * 바깥 요소는 `e1, e2...`, iframe 안쪽 요소는 `f1, f2...` 로 구분합니다.
 */
export async function snapshotBoth(
  page: Page,
  limit: number,
  snap: (t: Target, n: number, prefix: string) => Promise<SnapResult>,
): Promise<SnapResult & { inFrame: boolean; frameUrl: string | null; outerCount: number; frameCount: number }> {
  const outer = await snap(page, limit, 'e');
  const f = await contentTarget(page);
  if (!f.inFrame) {
    return { ...outer, inFrame: false, frameUrl: null, outerCount: outer.elements.length, frameCount: 0 };
  }
  const inner = await snap(f.target, limit, 'f');
  return {
    ...outer,
    elements: [...outer.elements, ...inner.elements],
    tables: [...outer.tables, ...inner.tables],
    inFrame: true,
    frameUrl: f.frameUrl,
    outerCount: outer.elements.length,
    frameCount: inner.elements.length,
  };
}


/** ref 앞글자로 어느 쪽 요소인지 알아내서 그쪽에서 집습니다. */
export async function targetForRef(page: Page, ref: string): Promise<Target> {
  if (!ref.startsWith('f')) return page;
  const f = await contentTarget(page);
  return f.target;
}
