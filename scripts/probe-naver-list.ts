/**
 * 상품목록 응답에 **어떤 칸이 있는지** 한 번 봅니다. 아무것도 안 바꿉니다(읽기만).
 *
 * 왜 필요한가: 상품수정 주소 `#/products/edit/{번호}` 의 번호는 **상품번호가 아니라 editId** 입니다
 * (사용자 확인 2026-08-02). 상품번호를 넣으면 다른 화면이 뜨거나 "접근권한이 없습니다" 가 납니다.
 * 그 editId 가 목록 응답의 어느 칸에 들어 있는지 이름을 몰라서, 칸 이름을 통째로 봅니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeBrowser, goTo, openBrowser } from '../src/browser.js';
import { outDir } from '../src/dump.js';
import { login } from '../src/login.js';
import { closeLayerPopups } from '../src/popup.js';

const { page, context, recorder } = await openBrowser({ blockImages: true });

const l = await login(page, context, 'naver_smartstore');
if (!l.ok) {
  console.log('로그인 실패:', l.이유);
  await closeBrowser().catch(() => {});
  process.exit(1);
}
for (const 줄 of l.한일) console.log('  -', 줄);
console.log('로그인 됨');

// 로그인 직후에는 등급 안내 같은 모달이 떠서 **다른 화면으로 못 갑니다.** 먼저 닫습니다.
const 팝업 = await closeLayerPopups(page);
console.log('안내창 닫음:', 팝업.found, '개', 팝업.remaining.length ? `(남은 것: ${팝업.remaining.join(', ')})` : '');

recorder.clear();
await goTo(page, 'https://sell.smartstore.naver.com/#/products/origin-list');
await page.waitForTimeout(9_000);
console.log('지금 주소:', page.url());
console.log('잡은 응답 주소:');
for (const e of recorder.all()) console.log('   ', e.status, e.url.replace(/\?.*$/, '').slice(0, 100));

const 목록 = recorder.all().find((e) => e.url.includes('/api/products/list/search'));
if (!목록?.body) {
  console.log('상품목록 응답을 못 잡았습니다.');
} else {
  // 응답 안에서 **줄이 여러 개 든 배열**을 찾습니다. 그것이 상품 목록입니다.
  const 찾기 = (v: unknown, 길 = ''): { 길: string; 첫줄: Record<string, unknown> } | null => {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0]) return { 길, 첫줄: v[0] as Record<string, unknown> };
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const r = 찾기(x, 길 ? `${길}.${k}` : k);
        if (r) return r;
      }
    }
    return null;
  };
  const 줄 = 찾기(목록.body);
  if (!줄) console.log('배열을 못 찾았습니다.');
  else {
    console.log(`상품 목록 자리: ${줄.길}\n칸 ${Object.keys(줄.첫줄).length}개:\n`);
    for (const [k, v] of Object.entries(줄.첫줄)) {
      const 값 = typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60);
      console.log(`  ${k.padEnd(34)} ${값}`);
    }
  }
  const 파일 = path.join(outDir(), 'naver-product-list-search.json');
  fs.mkdirSync(outDir(), { recursive: true });
  fs.writeFileSync(파일, JSON.stringify(목록.body, null, 2), 'utf8');
  console.log('\n전체 응답을 남겼습니다:', 파일);
}

await closeBrowser().catch(() => {});
