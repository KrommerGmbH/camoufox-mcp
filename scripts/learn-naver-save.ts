/**
 * ① 네이버에 로그인하고 → ② 상품수정 화면의 **저장 요청이 어떻게 생겼는지** 알아냅니다.
 *
 * **안전합니다.** `mode:'block'` 이라 저장 버튼을 눌러도 나가는 요청을 **잡아서 버립니다.**
 * 네이버 서버로 아무것도 안 갑니다. 상품은 하나도 안 바뀝니다.
 * (화면에 "저장 실패" 같은 안내가 뜰 수 있는데, 그건 우리가 막았기 때문이지 고장이 아닙니다.)
 *
 * **비밀번호는 이 스크립트를 부른 사람도, AI 도 안 봅니다.**
 * 샵웨어 서버가 잠긴 것을 풀어서 이 프로세스로만 보내고, 여기서 바로 화면에 칩니다.
 *
 * 왜 스크립트로 하나: MCP 서버는 세션이 시작될 때 읽은 코드로 돕니다.
 * 방금 만든 `browser_login`·`browser_submit` 이 그 서버에는 아직 없어서, 서버를 다시 켜지 않고 확인하려는 것입니다.
 *
 * 쓰는 법 (Node 22 이상):
 *   npx esbuild scripts/learn-naver-save.ts --bundle --platform=node --format=esm \
 *     --external:camoufox-js --external:playwright-core --external:better-sqlite3 \
 *     --outfile=scripts/.build/learn-naver-save.mjs
 *   SHOPWARE_API_URL=... node scripts/.build/learn-naver-save.mjs <상품번호>
 */
import { closeBrowser, openBrowser } from '../src/browser.js';
import { login } from '../src/login.js';
import { snapshot } from '../src/snapshot.js';
import { submit } from '../src/submit.js';

const 상품번호 = process.argv[2] ?? '12405647327';
const 주소 = `https://sell.smartstore.naver.com/#/products/edit/${상품번호}`;

console.log('※ 이 스크립트는 아무것도 저장하지 않습니다 (mode: block — 요청을 잡아서 버림)\n');

const { page, context, recorder } = await openBrowser({ blockImages: false });

console.log('① 로그인');
const l = await login(page, context, 'naver_smartstore');
for (const 줄 of l.한일) console.log('   -', 줄);
if (!l.ok) {
  console.log(`\n❌ 로그인 실패 (${l.단계}단계): ${l.이유}`);
  if (l.사람필요) console.log(`   사람이 할 것: ${l.사람필요}`);
  await closeBrowser().catch(() => {});
  process.exit(1);
}
console.log('   ✅ 로그인 됨');

console.log('\n② 상품수정 화면 열기:', 주소);
await page.goto(주소, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(4_000);
console.log('   지금 주소:', page.url());

console.log('\n③ 화면에서 "저장" 이 든 것 찾기');
const snap = await snapshot(page, { find: '저장', limit: 12 });
console.log(`   화면 전체 ${snap.totalOnScreen}개 중 "저장" 이 든 것 ${snap.elements.length}개`);
for (const e of snap.elements) {
  console.log(
    `     ${e.tag}  "${e.name ?? ''}"${e.nth !== undefined ? `  (겹침 순번 ${e.nth})` : ''}` +
      `\n        ${e.selectors[0]?.strategy}: ${e.selectors[0]?.expression}`,
  );
}

recorder.clear();

console.log('\n④ 저장 누르기 — 나가는 요청은 잡아서 버립니다');
const r = await submit(page, {
  // 넓게 겁니다. 어느 주소로 가는지 아직 모르기 때문입니다.
  // GET 은 그냥 통과시키므로 화면이 자료를 읽는 데는 지장이 없습니다.
  urlPattern: '**/api/**',
  mode: 'block',
  click: { do: 'click', text: '저장하기' },
  saveAs: `naver-product-${상품번호}-save`,
  waitMs: 20_000,
});

console.log('\n── 결과 ──────────────────────────────────────────');
console.log('누르기:', r.누르기.ok ? `성공 (${r.누르기.쓴것})` : `실패 — ${r.누르기.이유}`);
console.log('안내  :', r.안내);
for (const c of r.잡은요청) {
  console.log(`\n■ ${c.method} ${c.url}`);
  console.log(`  크기 ${c.bytes.toLocaleString()} 바이트 · 처리 ${c.처리}`);
  if (c.맨위칸이름) console.log(`  맨 위 칸 이름: ${c.맨위칸이름.join(', ')}`);
  if (c.본문) console.log(`  본문: ${JSON.stringify(c.본문).slice(0, 600)}`);
}
if (r.파일?.length) console.log('\n본문을 남긴 파일:', r.파일.join('\n           '));

// 가로채기가 놓친 것이 있는지 대조합니다. 잡은 것과 기록기가 본 것이 다르면 무늬가 좁았다는 뜻입니다.
const 기록 = recorder.writes();
if (기록.length) {
  console.log('\n(참고) 기록기가 본 값 바꾸는 요청:');
  for (const w of 기록) console.log(`  ${w.method} ${w.status} ${w.url}  보낸크기 ${w.sentBytes ?? 0}`);
} else {
  console.log('\n(참고) 기록기에 잡힌 값 바꾸는 요청 없음 = 네이버로 나간 것이 없다는 뜻입니다.');
}

console.log('\n20초 뒤 창을 닫습니다 (닫을 때 로그인 상태를 파일에 저장합니다).');
await page.waitForTimeout(20_000);
await closeBrowser().catch(() => {});
