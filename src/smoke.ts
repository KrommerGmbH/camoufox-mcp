import assert from 'node:assert/strict';
import { closeBrowser, openBrowser, runningBrowsers } from './browser.js';
import { safeKey } from './dump.js';
import { assertWebUrl } from './guard.js';
import { snapshot } from './snapshot.js';

/** 브라우저를 띄우지 않고도 확인할 수 있는 안전장치들. */
function checkGuards() {
  // 저장 폴더 밖으로 파일을 쓰려는 이름은 막혀야 합니다.
  assert.equal(safeKey('product-list'), 'product-list', '멀쩡한 이름은 그대로 남아야 합니다');
  for (const bad of ['../../.ssh/id_rsa', '..\\..\\win.ini', 'a/b/c', 'x:..\\y']) {
    const out = safeKey(bad);
    assert.ok(!/[/\\.:]/.test(out), `경로 문자가 남았습니다: ${bad} -> ${out}`);
  }
  assert.throws(() => safeKey('///'), /menuKey/, '경로만 있는 이름은 거부해야 합니다');

  // 이 컴퓨터의 파일을 여는 주소는 막혀야 합니다.
  assert.throws(() => assertWebUrl('file:///C:/Windows/win.ini'), /http\/https/);
  assert.throws(() => assertWebUrl('data:text/html,<b>x'), /http\/https/);
  assert.equal(assertWebUrl('https://example.com/a'), 'https://example.com/a');

  console.log('안전장치 확인 OK (파일 이름 · 주소 검사)');
}

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
  checkGuards();
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
  // 실제 관리자 화면처럼, 페이지 안에서 fetch 를 불러 뒤에서 오가는 JSON 을 잡습니다.
  await page.evaluate(
    (u) => fetch(u).then((r) => r.json()),
    JSON_TARGET,
  );
  await page.waitForTimeout(1500);
  const captured = recorder.all();
  const withBody = captured.filter((e) => e.body && typeof e.body === 'object');
  console.log(`잡힌 JSON 응답 ${captured.length}건 (본문 있는 것 ${withBody.length}건)`);
  if (!withBody.length && captured.length) {
    console.log('첫 항목:', JSON.stringify(captured[0]).slice(0, 300));
  }
  assert.ok(captured.length > 0, 'JSON 응답을 하나도 못 잡았습니다');
  assert.ok(withBody.length > 0, '본문이 담긴 JSON 응답이 없습니다');
  console.log(`본문 예시 키: ${Object.keys(withBody[0].body as object).slice(0, 5).join(', ')}`);

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
