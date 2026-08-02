import assert from 'node:assert/strict';
import { act } from './act.js';
import { apiCall, apiPatch } from './api.js';
import { closeBrowser, openBrowser, runningBrowsers } from './browser.js';
import { safeKey } from './dump.js';
import { assertWebUrl } from './guard.js';
import { snapshot } from './snapshot.js';
import { submit } from './submit.js';

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
  const snap = await snapshot(page, {});
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

  // ②-b 거르기와 "숨은 체크박스" (2026-07-31 에 실제로 데인 것)
  //
  // 네이버 상품속성의 "연령" 체크박스는 **크기가 0** 이고 그 위에 예쁜 네모가 그려져 있었습니다.
  // 예전 규칙(크기 0 이면 버림)으로는 목록에서 통째로 사라져서 누를 방법이 없었습니다.
  // 아래가 그 상황을 그대로 흉내 낸 것입니다.
  await page.setContent(`
    <label><input type="checkbox" name="age3" style="width:0;height:0;opacity:0"> 3세</label>
    <label><input type="checkbox" name="age4" style="width:0;height:0;opacity:0"> 4세</label>
    <button>저장하기</button><button>취소</button>
    <a href="#a">본문으로 바로가기</a><a href="#b">본문으로 바로가기</a>
    <div class="seller-input"><input class="ng-pristine ng-untouched" placeholder="상품명"></div>
  `);
  const hidden = await snapshot(page, {});
  assert.ok(
    hidden.elements.some((e) => e.tag === 'input'),
    '라벨이 보이는 숨은 체크박스를 놓쳤습니다(오늘 실패한 그 버그)',
  );

  const onlySave = await snapshot(page, { find: '저장' });
  assert.equal(onlySave.elements.length, 1, `find 로 걸렀는데 ${onlySave.elements.length}개가 왔습니다`);
  assert.ok((onlySave.totalOnScreen ?? 0) > 1, '거르기 전 개수를 안 알려줍니다');
  console.log(
    `거르기 OK: 화면 ${onlySave.totalOnScreen}개 중 "저장" 1개만 받음 · 숨은 체크박스도 잡힘`,
  );

  // ②-c 1순위 선택자가 겹치면 순번(nth)을 줘야 합니다.
  // 조사덤프 96화면에서 1순위 선택자의 9.9% 가 두 개 이상에 걸렸습니다(2026-08-01 실측).
  // 순번이 없으면 부르는 쪽은 늘 첫 번째만 누르게 됩니다.
  const dupLinks = hidden.elements.filter((e) => e.name === '본문으로 바로가기');
  assert.equal(dupLinks.length, 2, '글자가 같은 링크 2개를 못 찾았습니다');
  assert.deepEqual(
    dupLinks.map((e) => e.nth),
    [0, 1],
    '글자가 같은 링크에 순번(nth)이 안 붙었습니다',
  );
  const solo = hidden.elements.find((e) => e.name === '저장하기');
  assert.equal(solo?.nth, undefined, '겹치지 않는 요소에는 순번이 붙으면 안 됩니다');
  console.log('겹침 순번 OK: 같은 글자 링크 2개에 nth 0·1 · 안 겹치는 것엔 안 붙음');

  // ②-d AngularJS 상태 class 는 선택자에 넣으면 안 됩니다.
  // 한 번 클릭하면 ng-pristine → ng-dirty 로 바뀌어서, 그 선택자로는 두 번째부터 못 집습니다.
  const angular = hidden.elements.find((e) => e.placeholder === '상품명');
  assert.ok(angular, 'ng- class 가 붙은 입력칸을 못 찾았습니다');
  const dirty = hidden.elements.flatMap((e) => e.selectors).filter((s) => /\.ng-/.test(s.expression));
  assert.equal(dirty.length, 0, `선택자에 ng- 상태 class 가 ${dirty.length}개 남았습니다: ${dirty[0]?.expression}`);
  console.log('선택자 OK: 클릭하면 바뀌는 ng- 상태 class 가 안 들어감');

  // ②-e "하고 · 확인하기" — 찍어서 누르지 않고, 결과가 다르면 실패로 알려야 합니다.
  //
  // ⚠️ 여기서는 setContent 를 쓰지 않고 **진짜 http 화면**을 열어 내용만 바꿉니다.
  // setContent 로 만든 about:blank 화면에서는 Camoufox 의 마우스가 클릭을 끝내지 못합니다
  // (2026-08-01 실측: force 를 줘도 시간초과). 네이버는 진짜 http 화면이라 문제가 안 됩니다.
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => {
    document.body.innerHTML =
      '<button id="open">팝업 열기</button>' +
      '<div id="pop" style="display:none">저장되었습니다</div>' +
      '<button class="btn">지우기</button><button class="btn">지우기</button>';
    document.getElementById('open')!.onclick = () => {
      document.getElementById('pop')!.style.display = 'block';
    };
  });

  // ① 눌렀더니 기대한 글자가 떴다 → 성공
  const good = await act(page, { do: 'click', text: '팝업 열기', expect: { appears: '저장되었습니다' } });
  assert.equal(good.ok, true, `되어야 하는데 실패했습니다: ${good.이유}`);

  // ② 같은 선택자에 두 개가 걸림 → 찍지 말고 멈춰야 합니다
  const many = await act(page, { do: 'click', selectors: ['.btn'] });
  assert.equal(many.ok, false, '두 개가 걸렸는데 하나를 골라서 눌렀습니다');
  assert.equal(many.단계, '찾기');
  assert.ok(many.이유?.includes('2개'), `겹친 개수를 안 알려줍니다: ${many.이유}`);

  // ③ 눌리긴 했는데 기대한 결과가 아님 → 성공이라고 하면 안 됩니다
  const wrong = await act(page, {
    do: 'click',
    text: '팝업 열기',
    expect: { appears: '없는글자입니다', timeoutMs: 1500 },
  });
  assert.equal(wrong.ok, false, '결과가 다른데 성공이라고 했습니다');
  assert.equal(wrong.단계, '확인');
  console.log(`하고·확인 OK: 겹치면 멈춤(${many.이유?.slice(0, 24)}…) · 결과 다르면 실패(${wrong.실제})`);

  // ②-f API 로 값 읽고 고치기 — 선택자로 칸을 고르다 엉뚱한 칸에 넣은 사고(2026-08-02)의 대책.
  //
  // ⚠️ 화면 안의 fetch 는 **지금 열린 화면과 같은 도메인**만 부를 수 있습니다(브라우저 규칙).
  //    그래서 부를 API 쪽 화면을 먼저 엽니다. 실제 일에서도 같습니다 —
  //    상품 화면(sell.smartstore.naver.com)에서 상품 API(sell.smartstore.naver.com/api/…)를 부릅니다.
  //    (GitHub API 는 응답에 "이 문서 안에서는 아무것도 부르지 마라"는 규칙을 걸어 두어 검사에 못 씁니다.)
  const WIKI = 'https://en.wikipedia.org';
  await page.goto(`${WIKI}/wiki/Main_Page`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const SITEINFO = `${WIKI}/w/api.php?action=query&format=json&meta=siteinfo`;

  const readOne = await apiCall(page, { url: SITEINFO, pick: ['query.general.sitename'] });
  assert.equal(readOne.ok, true, `API 읽기 실패: ${readOne.이유 ?? readOne.status}`);
  assert.deepEqual(readOne.data, { 'query.general.sitename': 'Wikipedia' }, 'pick 으로 뽑은 값이 다릅니다');

  // pick 을 안 주면 큰 본문은 통째로 보내지 말고 칸 이름만 알려줘야 합니다.
  const big = `${WIKI}/w/api.php?action=query&format=json&list=allpages&aplimit=500`;
  const readAll = await apiCall(page, { url: big });
  assert.ok((readAll.크기 ?? 0) > 20_000, `큰 본문인데 크기를 안 알려줍니다 (${readAll.크기})`);
  assert.ok(
    JSON.stringify(readAll.data).includes('맨위칸이름'),
    'pick 없이 큰 본문을 통째로 보냈습니다',
  );

  // 없는 칸을 적으면 값을 만들지 말고 멈춰야 합니다.
  const noSuch = await apiPatch(page, {
    getUrl: SITEINFO,
    set: { '있을리없는.칸이름': 1 },
    dryRun: true,
  });
  assert.equal(noSuch.ok, false, '없는 칸인데 그냥 넘어갔습니다');
  assert.equal(noSuch.단계, '바꾸기');
  assert.equal(noSuch.보냄, false, '없는 칸인데 서버로 보냈습니다');

  // dryRun 은 무엇이 바뀔지만 알려주고 보내지 않아야 합니다.
  const dry = await apiPatch(page, {
    getUrl: SITEINFO,
    set: { 'query.general.sitename': '바뀔이름' },
    dryRun: true,
  });
  assert.equal(dry.ok, true, `dryRun 실패: ${dry.이유}`);
  assert.equal(dry.보냄, false, 'dryRun 인데 서버로 보냈습니다');
  assert.deepEqual(dry.바뀜, [{ 경로: 'query.general.sitename', 지금: 'Wikipedia', 바꿀값: '바뀔이름' }]);

  // 다른 도메인을 부르면 이유를 분명히 알려줘야 합니다(브라우저가 막는 것).
  const crossErr = await apiCall(page, { url: 'https://api.github.com/repos/daijro/camoufox' })
    .then(() => '')
    .catch((e) => String(e));
  assert.ok(crossErr.includes('도메인이 다릅니다'), `다른 도메인 안내가 없습니다: ${crossErr.slice(0, 80)}`);

  console.log(
    `API OK: pick 으로만 받음 · 큰 본문(${Math.round((readAll.크기 ?? 0) / 1024)}KB)은 칸 이름만 · ` +
      `없는 칸이면 멈춤 · dryRun 은 "${dry.바뀜[0].지금} → ${dry.바뀜[0].바꿀값}" 만 알려주고 안 보냄 · 다른 도메인은 이유 안내`,
  );

  // ③ JSON 수집기 (요구 6)
  // 실제 관리자 화면처럼, 페이지 안에서 fetch 를 불러 뒤에서 오가는 JSON 을 잡습니다.
  // 캐시가 남아 있으면 304 로 와서 본문이 비어 있습니다. 매번 다른 주소로 물어 새로 받게 합니다.
  await page.evaluate(
    (u) => fetch(u).then((r) => r.json()),
    `${JSON_TARGET}?nocache=${Date.now()}`,
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

  // ③-b **보낸 것**도 받아 적어야 합니다.
  // "저장 버튼을 누르면 네이버에 무엇이 어떤 모양으로 가는가"를 모르면,
  // 그 모양대로 보내는 것도 가로채서 고치는 것도 전부 찍는 것이 됩니다.
  await page.evaluate(() =>
    fetch('https://en.wikipedia.org/w/api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 저장할값: '브리오 36206', 개수: 3 }),
    }).catch(() => {}),
  );
  await page.waitForTimeout(1500);

  const saved = recorder.writes().find((e) => e.url.includes('api.php'));
  assert.ok(saved, '값을 바꾸는 요청을 못 잡았습니다');
  assert.equal(saved.method, 'POST');
  assert.ok((saved.sentBytes ?? 0) > 0, '보낸 크기를 안 적었습니다');
  assert.ok(!('sent' in saved), '목록에 보낸 본문이 통째로 실렸습니다(토큰 낭비)');

  const full = recorder.get(saved.ref);
  assert.deepEqual(full?.sent, { 저장할값: '브리오 36206', 개수: 3 }, '보낸 본문이 다릅니다');
  console.log(
    `보낸 것 OK: writes 로 저장요청 1건만 골라짐(${saved.method} ${saved.sentBytes}바이트) · ` +
      '목록엔 본문 빠짐 · ref 로 부르면 보낸 값 그대로',
  );

  // ④ 저장 가로채기 — **누르는 것은 코드가 하고, 나가는 요청은 우리가 통제합니다.**
  //
  // 여기서 확인하는 것이 핵심입니다: mode:'block' 이면 **버튼을 눌러도 서버로 안 갑니다.**
  // 그래서 "저장 요청이 어떻게 생겼나"를 사람 없이 안전하게 알아낼 수 있습니다.
  // (아래는 위키백과 API 를 저장 주소인 셈 치고 흉내 낸 것입니다. 위키에는 아무것도 안 씁니다.)
  const 저장무늬 = '**/w/api.php*';
  await page.evaluate(() => {
    document.body.innerHTML = '<button id="save">저장하기</button><div id="done"></div>';
    document.getElementById('save')!.onclick = () => {
      void fetch('/w/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: { name: '브리오 36206', salePrice: 96200 }, 개수: 3 }),
      })
        .then(() => {
          document.getElementById('done')!.textContent = '보냄';
        })
        .catch(() => {
          document.getElementById('done')!.textContent = '막힘';
        });
    };
  });

  const 막기 = await submit(page, {
    urlPattern: 저장무늬,
    mode: 'block',
    click: { do: 'click', text: '저장하기' },
    saveAs: 'smoke-save',
  });
  assert.equal(막기.ok, true, `저장 요청을 못 잡았습니다: ${막기.안내}`);
  assert.equal(막기.잡은요청.length, 1, `잡은 요청이 ${막기.잡은요청.length}건입니다`);
  assert.equal(막기.잡은요청[0].처리, '버림');
  assert.deepEqual(
    막기.잡은요청[0].본문,
    { product: { name: '브리오 36206', salePrice: 96200 }, 개수: 3 },
    '잡은 본문이 다릅니다',
  );
  // 진짜로 서버에 안 갔는지는 **화면이 압니다** — 요청이 막히면 브라우저가 실패로 알려줍니다.
  await page.waitForFunction(() => document.getElementById('done')?.textContent === '막힘', undefined, {
    timeout: 5_000,
  });
  assert.ok(막기.파일?.length, '본문을 파일로 안 남겼습니다');

  // 가로채기를 반드시 풀어야 합니다. 안 풀면 다음 저장이 계속 막히는데 아무도 이유를 모릅니다.
  const 푼뒤 = await page.evaluate(() =>
    fetch('/w/api.php?action=query&format=json&meta=siteinfo').then((r) => r.status).catch(() => 0),
  );
  assert.ok(푼뒤 > 0, '작업이 끝났는데 가로채기가 안 풀렸습니다 (다음 요청까지 막힙니다)');

  // 고치기: **본문에 없는 경로는 만들지 않아야** 합니다. 만들면 서버가 모르는 칸이 생깁니다.
  const 고치기 = await submit(page, {
    urlPattern: 저장무늬,
    mode: 'patch',
    click: { do: 'click', text: '저장하기' },
    set: { 'product.salePrice': 88800, '있을리없는.칸': 1 },
  });
  assert.deepEqual(
    고치기.잡은요청[0].바꾼것,
    [{ 경로: 'product.salePrice', 전: 96200, 후: 88800 }],
    '값을 안 바꿨거나 다르게 바꿨습니다',
  );
  assert.deepEqual(고치기.잡은요청[0].경로없음, ['있을리없는.칸'], '없는 경로를 만들어 버렸습니다');
  console.log(
    `저장 가로채기 OK: 코드가 눌렀고 · block 은 서버로 안 감(화면도 "막힘") · 본문 그대로 잡힘 · ` +
      `patch 는 96200→88800 만 바꾸고 없는 칸은 안 만듦 · 끝나면 가로채기 풀림`,
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
