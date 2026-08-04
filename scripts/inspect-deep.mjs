/**
 * **깊이 조사** — 메뉴만 훑는 조사(`inspect-menu.mjs`)가 못 잡는 두 가지를 잡습니다.
 *
 *   ① 주소에 번호가 붙어야 내용이 나오는 화면 (상품 상세·주문 상세·진단 상세 …)
 *   ② 눌러야 열리는 것 안쪽 (접힌 묶음 · 팝업/모달)
 *
 * **가장 중요한 규칙 — 목록의 줄은 화면 글자가 아니라 네트워크 JSON 에서 꺼냅니다.**
 * 화면 글자를 긁으면 느리고, 화면이 바뀌면 깨지고, 번호가 화면에 아예 안 나오는 경우도 많습니다.
 * JSON 에는 번호도 이름도 상태도 다 들어 있습니다. **모든 화면에 똑같이 적용합니다.**
 * (실측 2026-08-03: 등록 정보 검토 화면은 `sellerTags: []` · `notRegisteredAttributes: [...]` 처럼
 *  "무엇이 미등록인지"까지 JSON 이 그대로 알려줍니다. 화면에서 "미등록" 글자를 찾을 이유가 없습니다.)
 *
 * **아무것도 저장하지 않습니다.** 여는 버튼만 누르고, 닫을 때는 `취소`·`닫기` 만 누릅니다.
 * `저장`·`삭제`·`발송` 은 절대 안 누릅니다(아래 여는버튼/닫는버튼 목록 참고).
 *
 * 실행:
 *   node scripts/inspect-deep.mjs <화면키> <목록주소> [상세주소틀] [행수]
 * 예:
 *   node scripts/inspect-deep.mjs 01-16-listing-review \
 *     "https://sell.smartstore.naver.com/#/product/product-diagnosis" \
 *     "https://sell.smartstore.naver.com/#/product/product-diagnosis?channelProductNo={id}" 2
 *
 * 상세주소틀을 안 주면 목록만 조사합니다(그래도 JSON 에서 줄을 꺼내 기록해 둡니다).
 */
const PORT = process.env.CAMOUFOX_PORT ?? 8787;

/**
 * 조종 서버에 명령 하나를 보냅니다.
 *
 * **한 번 더 시도합니다.** 무거운 화면(입력칸 73개짜리 팝업)을 기록할 때 연결이 끊겨
 * `TypeError: fetch failed` 가 나는 일이 있습니다(2026-08-03 실측: 5개 중 3개가 이걸로 죽었습니다).
 * 서버는 멀쩡한데 연결만 끊긴 것이라, 잠깐 쉬었다 다시 부르면 됩니다.
 */
async function call(op, args = {}, 남은시도 = 2) {
  let res;
  try {
    res = await fetch(`http://localhost:${PORT}/call`, { method: 'POST', body: JSON.stringify({ op, ...args }) });
  } catch (e) {
    if (남은시도 <= 1) throw new Error(`${op}: 조종 서버에 못 닿았습니다 — ${String(e).split('\n')[0]}`);
    await sleep(3000);

    return call(op, args, 남은시도 - 1);
  }
  const j = await res.json();
  if (j.error) throw new Error(`${op}: ${j.error}`);

  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **여는 버튼** — 눌러도 아무것도 저장되지 않는, 화면을 펼치거나 팝업을 여는 글자만 적습니다.
 * 여기 없는 글자는 안 누릅니다. 목록을 늘릴 때는 "눌러도 마켓에 값이 안 남는가"를 먼저 따집니다.
 */
const 여는버튼 = ['수정', '설정', '변경', '선택', '추가', '더보기', '펼치기', '열기'];

/**
 * 여는버튼에서 **일부러 뺀 것과 이유** (다음 사람이 "왜 없지" 하고 다시 넣지 않게 적어 둡니다).
 *   `조회` · `검색` — 누르면 다른 화면으로 가 버립니다. 실측 2026-08-03: 상품수정 화면에서
 *                     `조회` 를 눌러 상품목록으로 튕겨 나가 그 다음 조사가 전부 헛돌았습니다.
 *   `등록`          — 새로 만드는 화면으로 갑니다. 빈 것을 만들어 두고 오는 사고가 납니다.
 */

/**
 * **접힌 묶음을 펴는 것** — 버튼이 아니라 `div` 인 경우가 많아 따로 봅니다.
 * 네이버 상품수정 화면의 접힌 칸을 펴는 것은 **글자가 정확히 `메뉴토글` 인 `<a>`** 입니다(한 화면에 18개).
 *
 * ⚠️ **"들어 있으면" 으로 찾으면 안 됩니다.** 그 묶음의 제목 줄(`div`)에도 `메뉴토글` 이 들어 있는데
 * (예: `검색설정 도움말 태그(독일약국화장품,흉터상처,…) 메뉴토글`), 그 `div` 는 가로 2,226px 짜리라
 * 가운데를 누르면 **빈 자리를 누릅니다.** 아무 일도 안 일어나고 조사가 통째로 헛돕니다(2026-08-03 실측).
 * 그래서 **글자가 정확히 같은 것만** 누릅니다.
 */
const 펴는글자 = ['메뉴토글', '펼치기', '더보기', '접기'];

/** **닫는 버튼** — 팝업을 되돌려 닫는 글자. `저장`·`확인` 은 값을 남길 수 있어 **일부러 뺐습니다.** */
const 닫는버튼 = ['취소', '닫기', '모달 닫기', '뒤로'];

/** 절대 안 누르는 글자. 실수로 여는버튼 목록에 들어가도 여기서 한 번 더 막습니다. */
const 금지버튼 = ['저장', '삭제', '발송', '전송', '확인', '적용', '결제', '주문', '승인', '반영'];

/** `--조회=조회` 처럼 주면, 목록을 연 뒤 그 글자의 버튼을 한 번 누릅니다(조회는 읽기만 합니다). */
const 조회글자 = process.argv.find((a) => a.startsWith('--조회='))?.split('=')[1] ?? null;

/** `--팝업` 을 주면 **목록 화면에서도** 여는 버튼을 눌러 봅니다(상세가 없는 화면은 이것뿐입니다). */
const 팝업모드 = process.argv.includes('--팝업');

const [, , 화면키, 목록주소, 상세주소틀, 행수인자, 칸이름인자] = process.argv.filter((a) => !a.startsWith('--'));
if (!화면키 || !목록주소) {
  console.error('사용법: node scripts/inspect-deep.mjs <화면키> <목록주소> [상세주소틀] [행수] [번호칸이름] [--조회=조회]');
  process.exit(1);
}
const 행수 = Number(행수인자 ?? 2);

/** 값이 든 그림·글꼴 같은 것은 목록 응답일 리 없습니다. 미리 버립니다. */
const 잡음 = /\.(svg|png|jpe?g|gif|woff2?|css|js)(\?|$)|facebook|pstatic\.net\/(?!.*json)/i;

/**
 * **어느 화면에나 뜨는 곁들이 응답** — 알림·공지·설정값 같은 것입니다.
 * 이것들도 줄이 여러 개라서 안 빼면 **그 화면의 목록으로 잘못 고릅니다.**
 * (실측 2026-08-03: 상품목록 화면에서 알림 10줄을 목록으로 착각해 조사가 통째로 헛돌았습니다.)
 */
const 곁들이 = /notification|user-activities|popup-notice|\/api\/context|shared\/codes|dock\/|badges|i18n|jwt|dns-is-safe|for-resource-menu|menus\/toggles|front-history/i;

/**
 * **목록의 줄이 들어 있는 응답을 찾습니다.**
 *
 * 어떻게 고르나: 응답 본문 안의 **객체 배열 중 가장 긴 것**을 그 화면의 목록으로 봅니다.
 * 이름을 정해 놓지 않는 이유 — 마켓마다 `items` · `content` · `list` · `data.rows` 로 제각각이고,
 * 이름을 찍어서 고르면 엉뚱한 배열(선택상자 후보 같은 것)을 목록으로 착각합니다.
 * 길이로 고르면 마켓이 늘어도 이 코드는 안 고칩니다.
 */
function 가장긴객체배열(본문) {
  let 최고 = null;
  const 훑기 = (o, 길) => {
    if (Array.isArray(o)) {
      if (o.length && o.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        if (!최고 || o.length > 최고.줄.length) 최고 = { 길, 줄: o };
      }
      return;
    }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) 훑기(v, 길 ? `${길}.${k}` : k);
  };
  훑기(본문, '');
  return 최고;
}

/**
 * **쪽 나눔이 있는 응답인가?**
 *
 * 줄이 가장 많은 것만 보면 **찾아보기용 목록**(택배사 목록 같은 것)에 집니다.
 * 실측 2026-08-03: 상품목록 화면에서 택배사 목록이 상품 81줄보다 많아서, 조사가
 * `#/products/edit/CJGLS`(택배사 코드) 로 들어가 통째로 헛돌았습니다.
 *
 * 가르는 기준: **그 화면의 진짜 목록은 쪽이 나뉘어 있습니다**(전체 개수·쪽 번호가 같이 옵니다).
 * 찾아보기용 목록은 한 번에 다 주므로 쪽 나눔 칸이 없습니다. 마켓이 늘어도 이 기준은 그대로입니다.
 */
const 쪽나눔칸 =
  /^(total|totalCount|totalItemCount|totalElements|totalPages|page|currentPage|pageNo|pageSize|size|hasNext|numberOfElements)$/i;
function 쪽나눔인가(본문) {
  let 수 = 0;
  const 훑기 = (o, 깊이) => {
    if (깊이 > 3 || !o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (쪽나눔칸.test(k) && (typeof v === 'number' || typeof v === 'boolean')) 수++;
      else 훑기(v, 깊이 + 1);
    }
  };
  훑기(본문, 0);
  return 수 >= 2;
}

/**
 * 사람에 대한 칸. **번호 후보에서 뺍니다.**
 *
 * 두 가지를 한 번에 막습니다.
 *  ① 개인정보가 화면(로그)에 찍히는 것 — 실측: `orderMemberTelNo=010-****-****` 가 후보로 찍혔습니다.
 *  ② 전화번호·회원번호를 주소에 끼워 넣는 것 — 그건 그 화면이 받는 번호가 아닙니다.
 */
const 사람칸 = /(tel|phone|mobile|hp|cell|name|nm|addr|zip|post|mail|member|customer|buyer|orderer|receiver|birth)/i;

/** 한 줄에서 "번호로 쓸 만한 칸"을 고릅니다. 이름을 찍지 않고 **모양으로** 고릅니다. */
function 번호칸들(줄) {
  return Object.entries(줄)
    .filter(([k, v]) => {
      if (v === null || typeof v === 'object') return false;
      if (사람칸.test(k)) return false;
      const s = String(v);
      // 6자리 이상 숫자이거나, 이름에 No/Id/Seq 가 붙은 칸.
      return /^\d{6,}$/.test(s) || /(no|id|seq)$/i.test(k);
    })
    .map(([k, v]) => [k, String(v)]);
}

/**
 * **요소 하나를 알아보는 열쇠.**
 *
 * ⚠️ `ref`(e1 · f12 …) 로 견주면 안 됩니다. `ref` 는 **그 스냅샷 안의 순번**일 뿐이라
 * 화면이 바뀌면 **같은 번호가 다른 것을 가리킵니다.** 그래서 팝업이 열려도
 * "새로 나온 것 없음" 으로 나옵니다(2026-08-03 실측: 19번 눌러 전부 "없음" 이었습니다).
 *
 * 그래서 **생김새로** 알아봅니다 — 태그 · 글자 · 안내글. 이건 화면이 다시 그려져도 그대로입니다.
 */
function 열쇠(e) {
  return [e.tag, (e.name || e.text || '').trim().slice(0, 60), e.placeholder || ''].join('|');
}

/** 사람이 읽는 이름으로 쓸 만한 칸(제목·상품명 등). 화면에서 그 줄을 찾아 누를 때 씁니다. */
function 이름칸(줄) {
  const 후보 = Object.entries(줄).find(
    ([k, v]) => typeof v === 'string' && v.length > 3 && /name|title|subject|productName/i.test(k),
  );
  return 후보 ? 후보[1] : null;
}

console.log(`※ 아무것도 저장하지 않습니다. 여는 버튼만 누르고 닫을 때는 취소·닫기만 누릅니다.\n`);

// ── ① 목록 화면: 네트워크 JSON 에서 줄을 꺼냅니다 ──────────────────────────
console.log(`① 목록 화면 열기: ${목록주소}`);
// 이미 그 화면에 서 있으면 목록을 **다시 안 부릅니다**(그러면 줄을 못 찾습니다).
// 그래서 먼저 다른 화면(첫 화면)에 들렀다 옵니다. 화면이 바뀌어야 목록을 새로 받아옵니다.
await call('goto', { url: 'https://sell.smartstore.naver.com/#/home/dashboard' }).catch(() => {});
await sleep(2500);
await call('netclear');
await call('goto', { url: 목록주소 });
await sleep(7000);

// 화면을 열기만 해서는 **줄이 안 오는 화면**이 있습니다.
// 실측 2026-08-03: `판매관리 > 발주(주문)확인/발송관리` 는 열어도 `getGraphqlServerTime` 하나만 오고
// 주문 줄은 **조회를 눌러야** 옵니다. 그래서 `--조회=조회` 처럼 누를 글자를 줄 수 있게 했습니다.
//
// 조회는 **읽기만 하는 버튼**이라 눌러도 안전합니다(저장·발송·삭제는 여전히 금지버튼입니다).
// 여는버튼 목록에 안 넣은 이유는 따로 있습니다 — 팝업을 여는 버튼이 아니라 화면을 갈아치우는 버튼이라,
// 팝업 조사 중에 누르면 조사가 통째로 헛돕니다.
if (조회글자) {
  console.log(`   목록을 부르려고 "${조회글자}" 를 누릅니다.`);
  const 지금 = await call('snapshot', { interactive: true });
  const 대상 = (지금.elements ?? []).find((e) => (e.name || e.text || '').trim() === 조회글자);
  if (!대상) console.log(`   ⚠️ "${조회글자}" 버튼을 화면에서 못 찾았습니다. 그냥 갑니다.`);
  else {
    await call('click', { ref: 대상.ref }).catch((e) => console.log(`   ⚠️ 못 눌렀습니다: ${String(e).split('\n')[0]}`));
    await sleep(6000);
  }
}

const 응답들 = (await call('netlist')).filter(
  (e) => !잡음.test(e.url) && !곁들이.test(e.url) && e.status === 200 && (e.bytes ?? 0) > 200,
);
// **전부 본 뒤에 고릅니다.** 순서: ① 쪽이 나뉜 것이 이깁니다 ② 그 다음에 줄이 많은 것.
// 먼저 걸리는 것을 쓰면 곁들이·찾아보기 응답이 이기는 일이 생깁니다.
let 목록 = null;
for (const e of 응답들) {
  const r = await call('netbody', { ref: e.ref }).catch(() => null);
  const 본문 = r?.body;
  if (!본문 || typeof 본문 !== 'object') continue;
  const 찾음 = 가장긴객체배열(본문);
  // 두 줄 미만이면 목록이라 보기 어렵습니다(설정값 한 덩어리일 수 있습니다).
  if (!찾음 || 찾음.줄.length < 2) continue;
  const 후보 = { url: e.url, 길: 찾음.길, 줄: 찾음.줄, 쪽나눔: 쪽나눔인가(본문) };
  if (!목록) 목록 = 후보;
  else if (후보.쪽나눔 !== 목록.쪽나눔) 목록 = 후보.쪽나눔 ? 후보 : 목록;
  else if (후보.줄.length > 목록.줄.length) 목록 = 후보;
}

if (!목록) {
  console.log('   ✗ 목록이 든 응답을 못 찾았습니다. 화면이 다 그려질 때까지 더 기다려야 할 수 있습니다.');
} else {
  console.log(`   목록 응답: ${목록.url.replace(/\?.*$/, '')}`);
  console.log(`   줄이 있는 자리: ${목록.길} · ${목록.줄.length}줄 · 쪽나눔 ${목록.쪽나눔 ? '있음' : '없음'}`);
  console.log(`   한 줄의 칸: ${Object.keys(목록.줄[0]).join(', ')}`);
  console.log(`   번호로 쓸 칸: ${번호칸들(목록.줄[0]).map(([k, v]) => `${k}=${v}`).join(' · ') || '(없음)'}`);
}

await call('dump', { menuKey: 화면키, menuPath: `깊이조사 > ${화면키} > 목록`, note: 목록 ? `목록 응답 ${목록.url}` : '목록 응답 못 찾음' });

/**
 * **지금 열려 있는 화면에서 "여는 버튼"을 하나씩 눌러 보고, 새로 나온 것을 기록합니다.**
 *
 * 상세 화면에서도, 목록 화면에서도 씁니다. 목록 화면에도 눌러야 열리는 것이 많습니다
 * (문의 답변창 · 취소 처리창 · 조회항목 설정 등). 전에는 상세 화면에서만 해서 그걸 다 놓쳤습니다.
 *
 * @param 팝업접두   팝업 화면 이름 앞에 붙일 것 (예: `03-04-menu-04` · `03-04-menu-04-detail`)
 * @param 자리이름   기록에 남길 자리 (`목록` · `상세`)
 * @param 돌아갈주소 닫는 버튼이 없을 때 화면을 되돌리려고 다시 열 주소
 * @param 메모       기록에 남길 한 줄
 */
async function 팝업조사(팝업접두, 자리이름, 돌아갈주소, 메모) {
  // 누르기 전에 **화면을 덮은 알림창부터 치웁니다.** 덮여 있으면 클릭이 조용히 빗나갑니다.
  const 첫정리 = await call('popups').catch(() => ({ found: 0 }));
  if (첫정리.found) console.log(`   알림창 ${첫정리.found}개를 먼저 치웠습니다`);

  const 전 = await call('snapshot', { limit: 600 });
  const 전열쇠 = new Set(전.elements.map(열쇠));
  const 열것 = 전.elements.filter((e) => {
    // `??` 는 빈 글자를 그냥 통과시킵니다. `name` 이 빈 글자면 `text` 를 봐야 하므로 `||` 를 씁니다.
    // (이것 때문에 `<a>메뉴토글</a>` 18개를 하나도 못 찾았습니다 — 2026-08-03)
    const 글 = (e.name || e.text || '').trim();
    if (!글 || 금지버튼.some((x) => 글 === x)) return false;
    // 팝업을 여는 버튼·링크는 **글자가 정확히 같을 때만** 누릅니다(비슷한 글자에 잘못 눌리지 않게).
    if ((e.tag === 'button' || e.tag === 'a') && 여는버튼.some((x) => 글 === x)) return true;
    // 접힌 묶음을 펴는 것도 **글자가 정확히 같은 것만** 누릅니다(위 펴는글자 설명 참고).
    return 펴는글자.some((x) => 글 === x);
  });
  console.log(`   눌러서 열 것 ${열것.length}개`);

  /**
   * 몇 번째 것을 누를지 **순번으로** 셉니다. 처음에 받은 `ref` 를 그대로 쓰면 안 됩니다.
   *
   * 왜: 묶음 하나를 펴면 그 아래 것들이 전부 밀려납니다. 그러면 처음에 받아둔 `ref` 는
   * **이미 다른 것을 가리키거나 사라진 상태**가 됩니다. 그 상태로 누르면 플레이라이트가
   * "요소가 멈출 때까지" 기다리다 15초 만에 죽습니다(2026-08-03 실측: 19개 중 11개가 이렇게 죽었습니다).
   * 그래서 **누르기 직전에 화면을 다시 읽고, 같은 글자의 n번째**를 골라 누릅니다.
   */
  const 열것글자 = 열것.map((e) => (e.name || e.text || '').trim());
  let 팝업번호 = 0;
  /** 지금 열려 있는 창 개수. 이보다 늘면 누르기가 새 창을 연 것입니다. */
  const 창수 = ((await call('pages')).pages ?? []).length;

  for (const [순번, 글] of 열것글자.entries()) {
    try {
      // 지금 화면에서 같은 글자를 가진 것들을 다시 세고, 그중 순번째를 누릅니다.
      const 지금 = await call('snapshot', { limit: 600 });
      const 같은글자 = 지금.elements.filter((e) => (e.name || e.text || '').trim() === 글);
      const 몇번째 = 열것글자.slice(0, 순번).filter((x) => x === 글).length;
      const 버튼 = 같은글자[몇번째];
      if (!버튼) {
        console.log(`     "${글}" — 화면에서 사라졌습니다(앞의 것을 펴면서 바뀐 듯합니다)`);
        continue;
      }

      await call('click', { ref: 버튼.ref, closePopups: false });
      await sleep(2500);

      // 누르면 **새 창이 열리는 것**이 있습니다(안전 규정·이용약관 안내 등).
      // 새 창이 열린 채로 두면 그 다음 조사가 엉뚱한 창을 보게 됩니다. 닫고 원래 창으로 돌아옵니다.
      const 창들 = (await call('pages')).pages ?? [];
      if (창들.length > 창수) {
        for (let i = 창들.length - 1; i >= 창수; i--) await call('closePage', { index: i }).catch(() => {});
        await call('usePage', { index: 0 }).catch(() => {});
        await sleep(1000);
        console.log(`     "${글}" — 새 창이 열려서 닫았습니다`);
      }

      let 후 = await call('snapshot', { limit: 600 });
      let 새것 = 후.elements.filter((e) => !전열쇠.has(열쇠(e)));

      // **눌렀으면 무엇이 달라졌는지 확인합니다.** 아무것도 안 달라졌으면 두 가지 중 하나입니다.
      //   ① 그냥 펼침이 아니었다  ② **무엇이 화면을 덮고 있어서 클릭이 빗나갔다**
      // ②는 조용히 틀립니다. 그래서 덮은 것이 있는지 보고, 있으면 치우고 **한 번 더** 눌러 봅니다.
      // (실측 2026-08-03: "이번달 등급 안내" 모달이 화면 전체 2560×930 을 덮고 있었는데
      //  오류는 "연결 실패"로 나와서 원인을 엉뚱한 곳에서 찾았습니다.)
      if (!새것.length) {
        const 덮은것 = await call('popups').catch(() => ({ found: 0 }));
        if (덮은것.found) {
          console.log(`     "${글}" — 화면을 덮은 알림창 ${덮은것.found}개를 치우고 다시 누릅니다`);
          const 다시 = await call('snapshot', { limit: 600 });
          const 다시버튼 = 다시.elements.filter((e) => (e.name || e.text || '').trim() === 글)[몇번째];
          if (다시버튼) {
            await call('click', { ref: 다시버튼.ref, closePopups: false });
            await sleep(2500);
            후 = await call('snapshot', { limit: 600 });
            새것 = 후.elements.filter((e) => !전열쇠.has(열쇠(e)));
          }
        }
      }

      if (!새것.length) {
        console.log(`     "${글}" — 새로 나온 것 없음(펼침이 아니었거나 이미 열려 있었습니다)`);
        continue;
      }

      팝업번호++;
      const 팝업키 = `${팝업접두}-popup-${String(팝업번호).padStart(2, '0')}`;
      await call('dump', {
        menuKey: 팝업키,
        menuPath: `깊이조사 > ${화면키} > ${자리이름} > "${글}" 눌러서 열린 것`,
        note: `${메모} · 새로 나온 요소 ${새것.length}개`,
      });
      const 입력 = 새것.filter((e) => e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select');
      console.log(
        `     "${글}" → 새 요소 ${새것.length}개 (입력칸 ${입력.length}개) → ${팝업키}` +
          (입력.length ? `  [${입력.map((e) => e.placeholder ?? e.name ?? '?').slice(0, 3).join(' · ')}]` : ''),
      );

      // 되돌려 닫습니다. **취소·닫기만** 누릅니다.
      const 닫을것 = 후.elements.find((e) => 닫는버튼.includes((e.name || e.text || '').trim()));
      if (닫을것) {
        await call('click', { ref: 닫을것.ref, closePopups: false }).catch(() => {});
        await sleep(1500);
      } else {
        // 닫는 버튼이 없으면 화면을 다시 읽어서 원래대로 돌립니다(저장 위험 없음).
        await call('goto', { url: 돌아갈주소 });
        await sleep(4000);
      }
    } catch (e) {
      console.log(`     "${글}" — ✗ ${String(e).split('\n')[0]}`);
    }
  }
}

// ── ①-2 목록 화면에서 눌러야 열리는 것 ────────────────────────────────────
// 목록 화면에도 팝업이 많습니다(문의 답변창·취소 처리창·조회항목 설정 등).
// 상세 주소틀이 없는 화면은 여기가 유일한 깊이 조사입니다.
if (팝업모드) {
  console.log('\n①-2 목록 화면에서 눌러 봅니다');
  await 팝업조사(화면키, '목록', 목록주소, '목록 화면');
}

// ── ② 상세 화면 + 눌러야 열리는 것 ───────────────────────────────────────
if (!상세주소틀 || !목록) {
  console.log('\n상세 주소틀이 없어 여기까지 합니다.');
  await call('save').catch(() => {});
  process.exit(0);
}

// **쪽 나눔이 없으면 상세로 안 들어갑니다.**
//
// 실측 2026-08-03: 발주확인/발송관리 화면에서 주문 줄이 안 왔는데(검색을 눌러야 옵니다),
// 그 화면에 같이 온 **공지 3줄**(`/sellers/tasks/exposure-infos`)을 목록으로 골랐습니다.
// 거기서 꺼낸 공지 번호 `sellerTaskId=45` 를 주문 상세 주소에 끼워 넣어
// `…/manage/order/popup/45/productOrderDetail` 로 들어갔고, 네이버가 **403(권한 없음)** 을 줬습니다.
//
// 목록이 아닌 것을 목록으로 잘못 골랐을 때 **남의 번호로 남의 화면에 들어가는 것**이 제일 위험합니다.
// 진짜 목록은 쪽이 나뉘어 있습니다(공리 1). 쪽 나눔이 없으면 목록으로 보지 않고 여기서 멈춥니다.
if (!목록.쪽나눔) {
  console.log('\n✗ 고른 응답에 쪽 나눔이 없습니다. 그 화면의 목록이 아닐 수 있어 상세로 들어가지 않습니다.');
  console.log('   목록이 아직 안 왔을 수 있습니다 — 조회/검색을 눌러야 오는 화면이면 `--조회=검색` 처럼 주세요.');
  await call('save').catch(() => {});
  process.exit(0);
}

// 주소틀의 `{id}` 자리에 넣을 칸을 고릅니다. 주소틀에 칸 이름이 적혀 있으면 그것을 씁니다.
// 예: `?channelProductNo={id}` → 줄에서 `channelProductNo` 를 찾습니다.
// 칸 이름을 직접 준 경우가 가장 셉니다. **주소마다 받는 번호가 다르기 때문입니다.**
// (네이버 실측: 진단 화면은 `channelProductNo`, 상품수정 화면은 `id`(editId) 를 받습니다. 서로 다른 번호입니다.)
const 틀에적힌칸 = 상세주소틀.match(/[?&]([A-Za-z]\w*)=\{id\}/)?.[1];
const 고른칸 =
  (칸이름인자 && 목록.줄[0][칸이름인자] !== undefined && 칸이름인자) ||
  (틀에적힌칸 && 목록.줄[0][틀에적힌칸] !== undefined && 틀에적힌칸) ||
  번호칸들(목록.줄[0])[0]?.[0] ||
  null;
if (!고른칸) {
  console.log('\n✗ 줄에서 번호로 쓸 칸을 못 찾았습니다.');
  process.exit(1);
}
console.log(`\n② 상세 화면 — 주소에 넣을 칸: ${고른칸}`);

for (const [i, 줄] of 목록.줄.slice(0, 행수).entries()) {
  const id = String(줄[고른칸]);
  const 이름 = 이름칸(줄) ?? '';
  console.log(`\n[${i + 1}/${행수}] ${고른칸}=${id}  ${이름.slice(0, 40)}`);

  await call('netclear');
  await call('goto', { url: 상세주소틀.replace('{id}', id) });
  await sleep(5000);

  const 상세키 = `${화면키}-detail`;
  if (i === 0) {
    const d = await call('dump', { menuKey: 상세키, menuPath: `깊이조사 > ${화면키} > 상세`, note: `${고른칸}=${id}` });
    console.log(`   상세 기록: 요소 ${d.elements} · 입력칸 ${d.fields} · API ${d.apis}`);
  }

  await 팝업조사(상세키, '상세', 상세주소틀.replace('{id}', id), `${고른칸}=${id}`);
}

await call('save').catch(() => {});
console.log('\n완료. 저장한 것은 하나도 없습니다.');
