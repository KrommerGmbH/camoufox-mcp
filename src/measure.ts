import { closeBrowser, current, openBrowser } from './browser.js';
import { snapshotBoth } from './frame.js';
import { locate } from './locate.js';
import { snapshot } from './snapshot.js';

/**
 * 토큰이 정말 줄었는지 **실제 화면에서** 잽니다.
 *
 * "줄었을 것이다" 는 근거가 아닙니다. 2026-07-31 세션에서 스냅샷 한 번이 150KB 였고
 * 버튼 하나 누르려고 그걸 열 번 넘게 불렀습니다. 얼마나 줄었는지 숫자로 봐야 합니다.
 *
 *   pnpm build && node dist/measure.js [주소] [찾을글자]
 */
const kb = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8') / 1024;
const row = (name: string, size: number, base: number, note = '') =>
  console.log(
    `  ${name.padEnd(34)} ${size.toFixed(1).padStart(7)} KB` +
      (base ? `  (${(base / size).toFixed(0)}배 작음)` : '') +
      (note ? `  ${note}` : ''),
  );

const url = process.argv[2] ?? 'https://sell.smartstore.naver.com/#/product/product-diagnosis';
const needle = process.argv[3] ?? '수정';

await openBrowser({});
const { page } = current();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

console.log(`\n화면: ${page.url()}\n`);

// ① 예전 방식 — 전부 받기
const all = await snapshotBoth(page, { limit: 400, verbose: true }, snapshot);
const allKb = kb(all);
row('① 예전: 전부 + 선택자 전부', allKb, 0, `요소 ${all.elements.length}개`);

// ② 선택자만 줄이기
const slim = await snapshotBoth(page, { limit: 400 }, snapshot);
row('② 선택자 2개만', kb(slim), allKb, `요소 ${slim.elements.length}개`);

// ③ 글자로 거르기 — 이게 핵심
const found = await snapshotBoth(page, { limit: 20, find: needle }, snapshot);
row(`③ find:"${needle}" 로 거르기`, kb(found), allKb, `요소 ${found.elements.length}개`);

// ④ 아예 스냅샷을 안 부르기 — click({text}) 이 쓰는 길
let four = 0;
try {
  const hit = await locate(page, { text: needle });
  const out = { clicked: needle, how: hit.how, url: page.url() };
  four = kb(out);
  row('④ 스냅샷 없이 바로 클릭', four, allKb, hit.how);
} catch (e) {
  console.log(`  ④ 스냅샷 없이 바로 클릭        못 찾음: ${String(e).split('\n')[0]}`);
}

console.log(
  `\n오늘 세션처럼 10번 부르면: 예전 ${(allKb * 10).toFixed(0)}KB → 지금 ${(four * 10).toFixed(1)}KB\n`,
);

await closeBrowser();
