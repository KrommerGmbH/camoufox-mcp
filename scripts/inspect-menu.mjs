/**
 * 왼쪽 메뉴를 마우스로 눌러가며 화면을 하나씩 조사합니다.
 *
 * 주소를 직접 치지 않습니다. 사람이 하듯 메뉴를 클릭해서 들어갑니다.
 * (주소를 바로 치면 사람이 안 하는 행동이라 눈에 띕니다.)
 *
 * 실행: node scripts/inspect-menu.mjs <대메뉴> <파일접두어> [건너뛸메뉴,...]
 * 예  : node scripts/inspect-menu.mjs "상품관리" 01 "상품 조회/수정"
 */
const PORT = process.env.CAMOUFOX_PORT ?? 8787;

async function call(op, args = {}) {
  const res = await fetch(`http://localhost:${PORT}/call`, {
    method: 'POST',
    body: JSON.stringify({ op, ...args }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${op}: ${j.error}`);
  return j;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 이름이 정확히 같은 요소의 ref 를 찾습니다. 비슷한 이름에 잘못 눌리지 않게 완전일치만 씁니다. */
function findRef(snap, name) {
  const hit = snap.elements.find((e) => (e.name ?? '').trim() === name);
  return hit?.ref ?? null;
}

/** 파일 이름으로 쓸 수 있게 한글 메뉴명을 영문 키로 바꿉니다. 없으면 번호만 씁니다. */
const KEY = {
  '그룹상품 소개': 'group-product-intro',
  '그룹상품 등록': 'group-product-create',
  '그룹상품 조회/수정': 'group-product-list',
  '그룹상품 리뷰이동': 'group-product-review',
  '그룹상품 노출 관리': 'group-product-display',
  '상품 조회/수정': 'product-list',
  '상품 등록': 'product-create',
  '상품 일괄등록': 'product-bulk-create',
  '카탈로그 가격관리': 'catalog-price',
  '연관상품 관리': 'related-product',
  '사진 보관함': 'photo-library',
  '배송정보 관리': 'delivery-info',
  '템플릿 관리': 'template',
  '공지사항 관리': 'notice',
  '구독 관리': 'subscription',
  '등록 정보 검토': 'listing-review',
  '검색 순위 진단': 'search-rank',
};

const [, , mainMenu, prefix, skipCsv, onlyCsv] = process.argv;
if (!mainMenu || !prefix) {
  console.error('사용법: node scripts/inspect-menu.mjs "상품관리" 01 ["건너뛸메뉴,..."] ["이것만,..."]');
  process.exit(1);
}
const skip = new Set((skipCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean));
/** 비어 있지 않으면 여기 적힌 메뉴만 조사합니다. 실패한 것만 다시 돌릴 때 씁니다. */
const only = new Set((onlyCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * 대메뉴 바로 아래에 딸린 하위 메뉴 이름을 읽습니다.
 * 대메뉴 다음부터 "다음 대메뉴(menuitem)" 를 만나기 전까지가 하위 목록입니다.
 */
function readSubs(snap) {
  const idx = snap.elements.findIndex((e) => (e.name ?? '').trim() === mainMenu);
  if (idx < 0) return null; // 대메뉴 자체를 못 찾음
  const subs = [];
  for (let i = idx + 1; i < snap.elements.length; i++) {
    const e = snap.elements[i];
    if (e.role === 'menuitem') break;
    if (e.tag === 'a' && e.name?.trim()) subs.push(e.name.trim());
  }
  return subs;
}

const HOME = 'https://sell.smartstore.naver.com/#/home/dashboard';

/** 화면 안에 뜨는 팝업(레이어). 이게 늘었으면 메뉴가 팝업으로 열린 것입니다. */
const MODAL = '[role="dialog"], .modal-content, .layer_popup, .seller-layer-modal';

/** 하위 목록이 이미 펼쳐져 있으면 그대로 쓰고, 접혀 있을 때만 누릅니다. */
async function openMainMenu() {
  let snap = await call('snapshot', { limit: 1500 });
  let subs = readSubs(snap);

  // 브라우저를 갓 열었으면 빈 화면입니다. 이때만 주소로 판매자센터에 들어갑니다.
  // (여기부터는 전부 마우스 클릭으로 다닙니다.)
  if (subs === null) {
    console.log('메뉴가 안 보입니다. 판매자센터 첫 화면으로 들어갑니다.');
    await call('goto', { url: HOME });
    await sleep(4000);
    snap = await call('snapshot', { limit: 1500 });
    subs = readSubs(snap);
  }
  if (subs === null) throw new Error(`대메뉴 "${mainMenu}" 를 못 찾았습니다. 로그인이 풀렸는지 확인하세요.`);

  if (subs.length) {
    console.log(`[${mainMenu}] 이미 펼쳐져 있음 — 하위 ${subs.length}개`);
    return subs;
  }

  const mainRef = findRef(snap, mainMenu);
  await call('click', { ref: mainRef });
  await sleep(1500);
  snap = await call('snapshot', { limit: 1500 });
  subs = readSubs(snap) ?? [];
  console.log(`[${mainMenu}] 눌러서 폄 — 하위 ${subs.length}개`);
  return subs;
}

const subs = await openMainMenu();
console.log(subs.map((s, i) => `  ${i + 1}. ${s}`).join('\n'));
console.log('');

let n = 0;
const results = [];
/** 지금 열린 창 개수. 이보다 늘어나면 새 창이 열린 것입니다. */
let tabCount = ((await call('pages')).pages ?? []).length;
for (const sub of subs) {
  n++;
  const num = String(n).padStart(2, '0');
  if (skip.has(sub) || (only.size && !only.has(sub))) {
    if (!only.size) console.log(`[${num}/${subs.length}] ${sub} — 건너뜀 (이미 조사함)`);
    continue;
  }

  const menuKey = `${prefix}-${num}-${KEY[sub] ?? `menu-${num}`}`;
  try {
    await call('netclear');

    // 메뉴가 접혔을 수 있으니 매번 확인하고, 없으면 대메뉴부터 다시 폅니다.
    let snap = await call('snapshot', { limit: 1500 });
    let ref = findRef(snap, sub);
    if (!ref) {
      const mainRef = findRef(snap, mainMenu);
      if (mainRef) {
        await call('click', { ref: mainRef });
        await sleep(1200);
        snap = await call('snapshot', { limit: 1500 });
        ref = findRef(snap, sub);
      }
    }
    if (!ref) {
      console.log(`[${num}/${subs.length}] ${sub} — ✗ 메뉴를 못 찾음`);
      results.push({ sub, ok: false, why: '메뉴 없음' });
      continue;
    }

    // 누르기 전 상태를 기억합니다. 셋 중 하나라도 바뀌어야 클릭이 먹은 것입니다.
    //   ① 주소가 바뀐다  ② 새 창이 열린다  ③ 화면 안에 팝업이 뜬다
    const before = (await call('status')).url;
    const modalsBefore = (await call('probe', { selector: MODAL })).length;

    // ⚠️ 팝업을 자동으로 닫지 않습니다.
    // "사진 보관함"처럼 팝업 자체가 그 메뉴의 화면인 경우가 있습니다.
    // 자동으로 닫으면 눌러도 아무 일 없는 것처럼 보입니다.
    await call('click', { ref, closePopups: false });
    await sleep(3500); // 화면이 다 그려질 때까지
    let pop = { found: 0, remaining: [] };

    // 새 창으로 열리는 메뉴가 있습니다(예: 사진 보관함).
    // 창이 늘었으면 그쪽으로 옮겨서 조사합니다.
    const tabs = (await call('pages')).pages;
    let newTab = false;
    if (tabs.length > tabCount) {
      const t = await call('usePage'); // 가장 최근 창으로
      console.log(`      ↳ 새 창에서 열렸습니다: ${t.url}`);
      newTab = true;
      tabCount = tabs.length;
      await sleep(2000);
    }

    let after = (await call('status')).url;
    let modalsAfter = (await call('probe', { selector: MODAL })).length;
    let newModal = modalsAfter > modalsBefore;

    // 셋 다 그대로면 클릭이 안 먹은 것입니다. 한 번 더 시도합니다.
    if (after === before && !newTab && !newModal) {
      const snap2 = await call('snapshot', { limit: 1500 });
      const ref2 = findRef(snap2, sub);
      if (ref2) {
        await call('click', { ref: ref2, force: true, closePopups: false });
        await sleep(3500);
        after = (await call('status')).url;
        modalsAfter = (await call('probe', { selector: MODAL })).length;
        newModal = modalsAfter > modalsBefore;
      }
    }
    if (after === before && !newTab && !newModal) {
      console.log(`[${num}/${subs.length}] ${sub} — ✗ 주소·새창·팝업 셋 다 안 바뀜 → 진짜 오류`);
      results.push({ sub, ok: false, why: '아무 반응 없음' });
      continue;
    }
    if (newModal) console.log(`      ↳ 팝업으로 열렸습니다 (이 팝업이 곧 화면입니다)`);

    const d = await call('dump', { menuKey, menuPath: `${mainMenu} > ${sub}` });

    // 새 창을 조사했으면 닫고 원래 창으로 돌아옵니다. 안 그러면 창이 계속 쌓입니다.
    if (newTab) {
      await call('closePage', { index: tabCount - 1 }).catch(() => {});
      await call('usePage', { index: 0 }).catch(() => {});
      tabCount = ((await call('pages')).pages ?? []).length;
      await sleep(1000);
    }

    // 팝업으로 열린 화면은 조사가 끝난 뒤에 닫습니다. 안 닫으면 다음 메뉴를 못 누릅니다.
    if (newModal) {
      pop = await call('popups');
      await sleep(800);
    }
    const line =
      `[${num}/${subs.length}] ${sub} → ${menuKey} | ` +
      `요소 ${d.elements} · 입력칸 ${d.fields} · 선택 ${d.selects} · API ${d.apis} · 표 ${d.tables}` +
      (pop.found ? ` | 팝업 ${pop.found}개 처리(남음 ${pop.remaining.length})` : '');
    console.log(line);
    results.push({ sub, ok: true, ...d, popups: pop.found, remaining: pop.remaining.length });
  } catch (e) {
    console.log(`[${num}/${subs.length}] ${sub} — ✗ ${String(e).split('\n')[0]}`);
    results.push({ sub, ok: false, why: String(e).split('\n')[0] });
  }

  // 중간에 끊겨도 로그인이 남게 자주 저장합니다.
  if (n % 4 === 0) await call('save').catch(() => {});
}

await call('save').catch(() => {});
console.log('');
console.log(`완료: 성공 ${results.filter((r) => r.ok).length} / 실패 ${results.filter((r) => !r.ok).length}`);
for (const r of results.filter((x) => !x.ok)) console.log(`  실패: ${r.sub} — ${r.why}`);
