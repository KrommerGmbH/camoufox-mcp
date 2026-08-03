/**
 * ① 네이버에 로그인하고 → ② 상품수정 화면에서 **저장 요청이 어떻게 생겼는지** 알아냅니다.
 *
 * **안전합니다.** `mode:'block'` 이라 저장 버튼을 눌러도 나가는 요청을 **잡아서 버립니다.**
 * 네이버 서버로 아무것도 안 갑니다. 상품은 하나도 안 바뀝니다.
 *
 * **상품을 여러 개 시도합니다.** 상품마다 필수값이 비어 있으면 화면이 먼저 막아서
 * 요청이 아예 안 나갑니다(실측 2026-08-02: "어린이제품 인증 카테고리입니다. 카탈로그,
 * 어린이제품인증을 필수로 입력해야 합니다"). 그런 상품으로는 저장 요청 모양을 알 수 없습니다.
 * 그래서 요청이 실제로 나가는 상품이 나올 때까지 차례로 눌러 봅니다. 전부 안 저장됩니다.
 *
 * **비밀번호는 이 스크립트를 부른 사람도, AI 도 안 봅니다.**
 * 샵웨어 서버가 잠긴 것을 풀어서 이 프로세스로만 보내고, 여기서 바로 화면에 칩니다.
 *
 * 쓰는 법 (Node 22 이상):
 *   npx esbuild scripts/learn-naver-save.ts --bundle --platform=node --format=esm \
 *     --external:camoufox-js --external:playwright-core --external:better-sqlite3 \
 *     --outfile=scripts/.build/learn-naver-save.mjs
 *   SHOPWARE_API_URL=... node scripts/.build/learn-naver-save.mjs [상품번호 ...]
 *
 * 상품번호를 안 주면 **상품 목록 화면에서 스스로 고릅니다.**
 */
import { closeBrowser, goTo, openBrowser } from '../src/browser.js';
import { login } from '../src/login.js';
import { closeLayerPopups as _cp } from '../src/popup.js';
import { submit } from '../src/submit.js';

/** 이 화면에는 저장 버튼이 두 개입니다(내용 아래 하나, 맨 아래 고정바에 하나). */
/** 둘 다 하는 일은 같지만 글자로 찾으면 두 개가 걸려 실행기가 멈춥니다. DB 의 자리까지 적힌 선택자를 씁니다. */
const 저장버튼 = [
  '#seller-content > ui-view > div.pc-fixed-area.navbar-fixed-bottom:nth-of-type(3) > div.btn-toolbar.pull-right:nth-of-type(2) > div.btn-group.btn-group-lg:nth-of-type(1) > button.btn.btn-primary:nth-of-type(2)',
  '#seller-content > ui-view > div.seller-sub-content:nth-of-type(2) > div.seller-btn-area.btn-group-xlg:nth-of-type(2) > button.btn.btn-primary:nth-of-type(2)',
];

const 목록주소 = 'https://sell.smartstore.naver.com/#/products/origin-list';
const 수정주소 = (no: string) => `https://sell.smartstore.naver.com/#/products/edit/${no}`;
/** 몇 개까지 눌러 볼지. 다 안 저장되지만 네이버 화면을 괜히 여러 번 열지 않으려고 막아 둡니다. */
const 최대시도 = Number(process.env.TRY_N ?? 12);

console.log('※ 이 스크립트는 아무것도 저장하지 않습니다 (mode: block — 요청을 잡아서 버림)\n');

const { page, context, recorder } = await openBrowser({ blockImages: true });

// ── ① 로그인 ────────────────────────────────────────────────────────────────
console.log('① 로그인');
const l = await login(page, context, 'naver_smartstore');
for (const 줄 of l.한일) console.log('   -', 줄);
if (!l.ok) {
  console.log(`\n❌ 로그인 실패 (${l.단계}단계): ${l.이유}`);
  console.log(`   지금 주소: ${l.url}`);
  if (l.화면) console.log(`   화면에 떠 있는 글자: ${l.화면}`);
  await closeBrowser().catch(() => {});
  process.exit(1);
}
console.log('   ✅ 로그인 됨');

// ── ② 눌러 볼 상품 고르기 ───────────────────────────────────────────────────
let 후보 = process.argv.slice(2).filter((a) => /^\d{6,}$/.test(a));

if (!후보.length) {
  console.log('\n② 상품번호를 안 줘서 목록 화면에서 고릅니다:', 목록주소);
  recorder.clear();
  await goTo(page, 목록주소);
  await page.waitForTimeout(4_000);

  // 화면 글자를 긁지 않고 **네트워크 JSON 에서** 뽑습니다. 훨씬 빠르고 안 깨집니다.
  // 상품 하나를 가리키는 이름이 응답마다 달라서(originProductNo · channelProductNo …)
  // 이름을 정해 놓지 않고 **그 세 이름의 값만** 모읍니다.
  // 어느 응답에서 어떤 이름으로 나오는지 먼저 보여 줍니다.
  // 이름을 찍어서 고르면 엉뚱한 번호를 씁니다 — 실제로 그룹상품 번호를 뽑아서 전부 헛돌았습니다.
  // 어느 응답에서 어떤 이름으로 나오는지는 한 번 알아냈습니다. 매번 찍지 않습니다.
  const 보여주기 = process.env.SHOW_LIST_APIS === '1';
  if (보여주기) console.log('   목록 화면이 부른 JSON 응답:');
  for (const e of recorder.all()) {
    if (!e.body || typeof e.body !== 'object') continue;
    const 글 = JSON.stringify(e.body);
    const 이름들 = [...new Set([...글.matchAll(/"(\w*[Pp]roductNo)":/g)].map((m) => m[1]))];
    if (보여주기) console.log(`     ${e.url.replace(/\?.*$/, '').slice(0, 90)}  ${Math.round(글.length / 1024)}KB` + (이름들.length ? `  번호이름: ${이름들.join(', ')}` : ''));
  }

  // **상품목록 응답의 `id` 칸**을 씁니다.
  //
  // ⚠️ 상품수정 주소 `#/products/edit/{번호}` 의 {번호}는 **상품번호가 아닙니다.**
  //    네이버가 수정 화면 전용으로 따로 쓰는 번호(editId)이고, 목록 응답에서는 `id` 칸입니다.
  //    (실측 2026-08-02: 첫 줄은 id=13616724496 인데 storefarmChannelProductNo=13676846352 로 서로 다릅니다.)
  //    `channelProductNo` 를 주소에 넣으면 다른 화면이 뜨거나 "접근권한이 없습니다" 가 납니다.
  //    12개를 그렇게 넣어 보고 전부 실패한 뒤에야 알았습니다.
  const 목록 = recorder.all().find((e) => e.url.includes('/api/products/list/search'));
  const 줄들 = ((목록?.body as { content?: Array<{ id?: number | string; productName?: string }> })?.content ?? []).filter(
    (r) => r.id,
  );

  후보 = 줄들.slice(0, 최대시도).map((r) => String(r.id));
  console.log(`   상품목록 응답의 id 칸에서 ${줄들.length}개를 찾았습니다. 앞의 ${후보.length}개를 눌러 봅니다.`);
  for (const r of 줄들.slice(0, 최대시도)) console.log(`     ${r.id}  ${String(r.productName ?? '').slice(0, 40)}`);
}

if (!후보.length) {
  console.log('\n❌ 눌러 볼 상품번호를 못 찾았습니다. 상품번호를 인자로 주세요.');
  await closeBrowser().catch(() => {});
  process.exit(1);
}

// ── ③ 요청이 실제로 나갈 때까지 차례로 눌러 봅니다 (전부 안 저장됨) ─────────
let 성공: Awaited<ReturnType<typeof submit>> | null = null;
let 성공번호 = '';

for (const no of 후보) {
  console.log(`\n③ 상품 ${no} — 상품수정 화면 열기`);
  await goTo(page, 수정주소(no));
  await page.waitForTimeout(3_500);

  // 안내창이 떠 있으면 버튼을 가립니다. **닫기까지만** 자동으로 합니다(확인은 안 누릅니다).
  const 팝업 = await _cp(page);
  if (팝업.found) console.log(`   안내창 ${팝업.found}개 닫음`);

  recorder.clear();
  const r = await submit(page, {
    // **모든 주소**를 겁니다. 저장 주소가 `/api/` 를 안 쓸 수도 있어서입니다.
    // 값을 바꾸는 방식(POST·PUT·PATCH·DELETE)만 잡고 나머지는 그냥 통과시키므로
    // 화면이 그림·글자·자료를 읽는 데는 지장이 없습니다.
    urlPattern: '**',
    mode: 'block',
    click: { do: 'click', selectors: 저장버튼 },
    saveAs: `naver-product-${no}-save`,
    waitMs: 8_000,
  });

  if (r.잡은요청.length) {
    성공 = r;
    성공번호 = no;
    break;
  }

  console.log(`   요청 안 나감 — ${r.누르기.ok ? '화면이 먼저 막았습니다' : `못 눌렀습니다: ${r.누르기.이유}`}`);
  if (r.화면) console.log(`   화면: ${r.화면.slice(0, 160)}`);
}

// ── 결과 ────────────────────────────────────────────────────────────────────
console.log('\n── 결과 ──────────────────────────────────────────');
if (!성공) {
  console.log(`상품 ${후보.length}개를 눌러 봤는데 전부 화면에서 막혔습니다.`);
  console.log('필수값이 다 채워진 상품의 번호를 인자로 주세요.');
} else {
  console.log(`상품 ${성공번호} 에서 저장 요청을 잡았습니다. **네이버에는 안 갔습니다.**\n`);
  for (const c of 성공.잡은요청) {
    console.log(`■ ${c.method} ${c.url}`);
    console.log(`  크기 ${c.bytes.toLocaleString()} 바이트 · 처리 ${c.처리}`);
    if (c.맨위칸이름) console.log(`  맨 위 칸 이름: ${c.맨위칸이름.join(', ')}`);
    if (c.본문) console.log(`  본문: ${JSON.stringify(c.본문).slice(0, 800)}`);
    console.log('');
  }
  if (성공.파일?.length) console.log('본문을 남긴 파일:\n  ' + 성공.파일.join('\n  '));
}

const 기록 = recorder.writes();
console.log(
  기록.length
    ? `\n(참고) 기록기가 본 값 바꾸는 요청 ${기록.length}건 — 막았으므로 응답은 실패로 뜹니다.`
    : '\n(참고) 기록기에 잡힌 값 바꾸는 요청 없음 = 네이버로 나간 것이 없다는 뜻입니다.',
);

await closeBrowser().catch(() => {});
