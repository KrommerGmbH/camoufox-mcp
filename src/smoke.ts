import assert from 'node:assert/strict';
import { closeBrowser, openBrowser, runningBrowsers } from './browser.js';
import { snapshot } from './snapshot.js';

/**
 * 최소 점검 1회분.
 * 이게 통과하면 "Windows 에서 Camoufox 가 뜨고, 요소가 뽑히고, JSON 이 잡힌다" 가 확인됩니다.
 * 실행: pnpm build && pnpm smoke
 */
/** 요소가 확실히 있는 페이지 */
const DOM_TARGET = process.env.SMOKE_URL ?? 'https://www.wikipedia.org/';
/** JSON 을 확실히 돌려주는 주소 */
const JSON_TARGET = 'https://api.github.com/repos/daijro/camoufox';

async function main() {
  console.log('지금 실행 중인 브라우저:', runningBrowsers().join(', ') || '(없음)');

  const t0 = Date.now();
  const { page, recorder } = await openBrowser({ blockImages: false });
  console.log(`창 띄우기 ${Date.now() - t0}ms`);

  // ① 요소 뽑기
  await page.goto(DOM_TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  const snap = await snapshot(page);
  console.log(`요소 ${snap.elements.length}개 / 표 ${snap.tables.length}개 / 제목 "${snap.title}"`);
  assert.ok(snap.elements.length > 0, '요소를 하나도 못 뽑았습니다');
  assert.ok(
    snap.elements.every((e) => e.selectors.length > 0),
    '선택자가 없는 요소가 있습니다',
  );

  // ② ref 로 요소를 진짜 집을 수 있는지 (좌표를 안 쓰는지)
  const first = snap.elements[0];
  const found = await page.locator(`[data-cfx-ref="${first.ref}"]`).count();
  assert.equal(found, 1, `ref ${first.ref} 로 요소를 못 집었습니다`);
  console.log(`ref 로 집기 OK (${first.ref} = ${first.tag} "${first.name ?? ''}")`);

  // ③ JSON 수집기 (요구 6)
  await page.goto(JSON_TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  const captured = recorder.all();
  console.log(`잡힌 JSON 응답 ${captured.length}건`);
  assert.ok(captured.length > 0, 'JSON 응답을 하나도 못 잡았습니다');
  assert.ok(
    captured.some((e) => e.body && typeof e.body === 'object'),
    '본문이 담긴 JSON 응답이 없습니다',
  );

  console.log('\n✅ 전부 통과. 창에서 직접 로그인하면 프로필에 그대로 남습니다.');
  console.log('   10초 뒤 창이 닫힙니다.');
  await page.waitForTimeout(10_000);
  await closeBrowser();
}

main().catch(async (e) => {
  console.error('❌ 실패:', e);
  await closeBrowser();
  process.exit(1);
});
