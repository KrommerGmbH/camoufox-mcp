import type { BrowserContext, Page } from 'playwright-core';
import { act } from './act.js';
import { goTo } from './browser.js';

/**
 * 마켓에 로그인합니다.
 *
 * **AI 는 비밀번호를 못 봅니다.** 이것이 이 파일이 있는 이유의 전부입니다.
 * 비밀번호는 샵웨어 서버가 자물쇠를 풀어서 **이 Node 프로세스로만** 보내고, 여기서 바로 화면에 칩니다.
 * 모델(AI)에게는 "로그인 됐다/안 됐다" 와 이유만 갑니다. 값은 한 번도 안 지나갑니다.
 * (자물쇠: `CmhAiSecretBox` — 열쇠는 서버 `.env` 의 APP_SECRET 에서 만듭니다.)
 *
 * **무엇을 어떻게 누를지도 코드에 안 박습니다.** 표(`cmh_ai_platform.login_flow`)에서 읽습니다.
 * 쿠팡·지마켓이 늘어도 이 파일은 안 고칩니다. 표에 줄만 더합니다.
 */

const BASE = (process.env.SHOPWARE_API_URL ?? '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SHOPWARE_API_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SHOPWARE_API_CLIENT_SECRET ?? '';

interface Field {
  key: string;
  label?: string;
  selectors: string[];
  /** 서버가 채워서 보내 준 값. **여기에 비밀번호가 들어 있습니다.** 절대 밖으로 내보내지 않습니다. */
  value?: string;
}

interface Recipe {
  accountId: string;
  platformCode: string;
  baseUrl?: string | null;
  loginUrl: string;
  fields: Field[];
  submit?: { selectors: string[] } | null;
  error?: { selectors: string[] } | null;
  check?: {
    api?: string;
    okStatus?: number;
    failStatus?: number;
    url?: string;
    loggedOutText?: string;
    /** 이 조각이 **주소**에 들어 있으면 로그아웃이다. 글자보다 정확하다(아래 판정() 설명 참고). */
    loggedOutUrl?: string[];
  } | null;
  /**
   * 자동입력 방지 문자를 어떻게 할지. **마켓마다 다르므로 표에서 읽습니다.**
   * `how: 'random'` = 아무 글자나 넣어도 통과하는 마켓(네이버 커머스가 그렇다 — 2026-08-02 확인).
   * `how` 가 없거나 다른 값이면 사람에게 넘깁니다.
   */
  captcha?: { selectors: string[]; how?: string; length?: number } | null;
  manual?: { reason?: string; timeoutSec?: number } | null;
  storageState?: string | null;
}

export interface LoginResult {
  ok: boolean;
  market: string;
  /** 어디까지 갔다가 멈췄나 */
  단계: '레시피' | '쿠키' | '입력' | '보내기' | '확인';
  이유?: string;
  url: string;
  /** 실패했을 때 화면에 떠 있던 글자(앞부분만). 왜 안 됐는지는 화면이 알고 있습니다. */
  화면?: string;
  /** 사람이 손대야 하는 것(있으면). 2단계 인증·기기 등록 같은 것. */
  사람필요?: string;
  /** 무엇을 했는지 한 줄씩. **값은 절대 안 적습니다.** */
  한일: string[];
}

let token = '';
let tokenUntil = 0;

/**
 * 샵웨어 창구를 부릅니다. 토큰은 여기서 받아 두고 다시 씁니다.
 * `secret.ts` 도 같은 길로 부르므로 밖에서도 쓸 수 있게 열어 둡니다.
 */
export async function shopware<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  if (!BASE || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'SHOPWARE_API_URL · SHOPWARE_API_CLIENT_ID · SHOPWARE_API_CLIENT_SECRET 을 이 서버의 환경변수로 주세요.\n' +
        '비밀번호를 꺼내오는 곳이 샵웨어라서 필요합니다.',
    );
  }
  if (!token || Date.now() > tokenUntil - 30_000) {
    const res = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    if (!res.ok) throw new Error(`샵웨어 로그인 실패 (${res.status}). 통합 키를 확인하세요.`);
    const b = (await res.json()) as { access_token: string; expires_in: number };
    token = b.access_token;
    tokenUntil = Date.now() + b.expires_in * 1000;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const txt = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    throw new Error(`${path} 실패 (${res.status}): ${txt.slice(0, 200)}`);
  }
  const o = parsed as { success?: boolean; message?: string; errors?: Array<{ detail?: string }> };
  if (!res.ok || o?.success === false) {
    throw new Error(o?.message ?? o?.errors?.map((e) => e.detail).join(' / ') ?? `실패 ${res.status}`);
  }

  return parsed as T;
}

/**
 * 자동입력 방지 글자에 넣을 아무 글자.
 * 네이버 커머스는 이 글자를 실제로 안 맞춰 봅니다(2026-08-02 사용자 확인).
 * 그래서 비워 두면 못 넘어가고, 아무 글자나 넣으면 넘어갑니다.
 */
function 아무글자(n = 8): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];

  return s;
}

/**
 * 지금 로그인 되어 있는지 마켓 API 로 물어봅니다. 화면 글자보다 정확합니다.
 *
 * **화면 안에서 fetch 로 부르면 안 됩니다.** 로그인 직후에는 화면이 아직
 * `accounts.commerce.naver.com` 에 있는데, 확인 API 는 `sell.smartstore.naver.com` 에 있습니다.
 * 브라우저는 다른 도메인 부르기를 막고 이유도 안 알려 줍니다 —
 * 그러면 "로그인 안 됐다"로 잘못 읽습니다(2026-08-02 실제로 그랬습니다).
 *
 * 그래서 **브라우저 바깥(context.request)에서** 부릅니다.
 * 쿠키는 창과 같은 것을 씁니다. 도메인 제한은 화면 안에만 있는 규칙이라 여기엔 없습니다.
 */
async function 로그인상태(
  page: Page,
  context: BrowserContext,
  check: Recipe['check'],
): Promise<{ 상태: number | null; 어디서: string }> {
  if (!check?.api) return { 상태: null, 어디서: '확인 방법이 표에 없음' };

  // ① 화면이 그 API 와 **같은 도메인**이면 화면 안에서 부릅니다.
  //    화면이 평소에 쓰는 쿠키·헤더가 그대로 실려서 가장 정확합니다.
  try {
    if (new URL(page.url()).origin === new URL(check.api).origin) {
      const s = await page.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).status, check.api);

      return { 상태: s, 어디서: '화면 안' };
    }
  } catch {
    /* 주소가 about:blank 같으면 아래로 넘어갑니다. */
  }

  // ② 도메인이 다르면 화면 안에서는 못 부릅니다(브라우저가 막습니다).
  //    브라우저 **밖**에서 부릅니다. 쿠키는 창과 같은 것을 씁니다.
  const r = await context.request.get(check.api, { failOnStatusCode: false, timeout: 15_000 }).catch(() => null);

  return { 상태: r ? r.status() : null, 어디서: '브라우저 밖' };
}

/**
 * 상태 번호를 "로그인 됐다/안 됐다"로 읽습니다.
 *
 * **아는 번호가 아니면 화면을 봅니다.** 마켓이 API 를 바꾸면 표에 적힌 번호가 안 맞게 됩니다
 * (실측 2026-08-02: 로그인이 됐는데도 `/api/login/init` 이 400 을 줬습니다.
 *  표에는 "200 이면 로그인, 401 이면 로그아웃"이라고 적혀 있었습니다).
 * 그때 "로그인 안 됨"으로 단정하면 멀쩡한 로그인을 실패로 보고합니다.
 * 화면은 늘 있으니, 모르는 번호가 오면 화면에 로그아웃 글자가 보이는지로 정합니다.
 */
async function 판정(
  page: Page,
  context: BrowserContext,
  check: Recipe['check'],
): Promise<{ 됐나: boolean | null; 어떻게: string }> {
  const { 상태, 어디서 } = await 로그인상태(page, context, check);
  const ok = check?.okStatus ?? 200;
  const fail = check?.failStatus;

  if (상태 === ok) return { 됐나: true, 어떻게: `${어디서} ${상태} (아는 번호)` };
  if (fail !== undefined && 상태 === fail) return { 됐나: false, 어떻게: `${어디서} ${상태} (아는 번호)` };

  if (!check?.url) {
    return { 됐나: 상태 === null ? null : false, 어떻게: `${어디서} ${상태 ?? '못 물어봄'} (모르는 번호인데 화면으로 볼 방법이 표에 없음)` };
  }

  // **로그인해야만 볼 수 있는 화면으로 가 봅니다.** 로그아웃이면 마켓이 딴 데로 보냅니다.
  // 주소로 보는 것이 화면 글자로 보는 것보다 정확합니다 —
  // 글자는 화면이 다 그려지기 전에 읽으면 비어 있어서 "로그인됨"으로 잘못 읽습니다
  // (실측 2026-08-02: 로그아웃 화면인데 글자가 아직 없어서 로그인이라고 판단했습니다).
  await goTo(page, check.url).catch(() => {});
  await page.waitForTimeout(3_000);
  const 지금 = page.url();

  const 튕김 = (check.loggedOutUrl ?? []).find((조각) => 지금.includes(조각));
  if (튕김) return { 됐나: false, 어떻게: `${어디서} ${상태 ?? '못 물어봄'} 은 모르는 번호 → 주소를 봄: "${튕김}" 으로 튕김(로그아웃)` };

  if (check.loggedOutText) {
    const 로그아웃 = (await 화면요약(page)).includes(check.loggedOutText);
    if (로그아웃) return { 됐나: false, 어떻게: `${어디서} ${상태 ?? '못 물어봄'} 은 모르는 번호 → 화면에 "${check.loggedOutText}" 가 보임(로그아웃)` };
  }

  return { 됐나: true, 어떻게: `${어디서} ${상태 ?? '못 물어봄'} 은 모르는 번호 → 주소가 안 튕김(로그인): ${지금.slice(0, 60)}` };
}

/** 실패했을 때 화면에 무엇이 떠 있는지. **왜 안 됐는지는 화면이 알고 있습니다.** */
async function 화면요약(page: Page): Promise<string> {
  const txt = await page
    .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400))
    .catch(() => '');

  return txt;
}

/**
 * 자동입력 방지 문자 칸이 **보이고 비어 있으면** 아무 글자를 넣습니다.
 *
 * **보내기 전에** 합니다. 나중에 하면 로그인이 한 번 실패한 뒤에 채우게 되는데,
 * 실패한 로그인 시도가 쌓이면 마켓이 계정을 잠글 수 있습니다.
 *
 * @return 넣었으면 넣은 글자 수, 안 넣었으면 null
 */
async function 방지문자채우기(page: Page, cap: Recipe['captcha']): Promise<number | null> {
  if (!cap?.selectors?.length || cap.how !== 'random') return null;

  for (const sel of cap.selectors) {
    const el = page.locator(sel).first();
    const 보임 = await el.isVisible().catch(() => false);
    if (!보임) continue;
    if ((await el.inputValue().catch(() => 'x')) !== '') continue;

    const 값 = 아무글자(cap.length ?? 8);
    const r = await act(page, { do: 'type', selectors: [sel], value: 값 });
    if (r.ok) return 값.length;
  }

  return null;
}

export async function login(page: Page, context: BrowserContext, market: string): Promise<LoginResult> {
  const 한일: string[] = [];
  const 결과 = (r: Partial<LoginResult> & Pick<LoginResult, 'ok' | '단계'>): LoginResult => ({
    market,
    url: page.url(),
    한일,
    ...r,
  });

  // ── ① 레시피 받기 (여기에 비밀번호가 실려 옵니다. 밖으로 안 나갑니다) ──────
  let recipe: Recipe;
  try {
    recipe = await shopware<Recipe>(`/api/_action/cmh-ai/login/recipe?market=${encodeURIComponent(market)}`, 'GET');
  } catch (e) {
    return 결과({ ok: false, 단계: '레시피', 이유: e instanceof Error ? e.message : String(e) });
  }
  한일.push(`레시피 받음 (${recipe.platformCode}, 채울 칸 ${recipe.fields.length}개)`);

  // ── ② 저장해 둔 쿠키가 아직 살아 있으면 로그인 안 합니다 ─────────────────
  if (recipe.storageState) {
    try {
      const st = JSON.parse(recipe.storageState) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
      const now = Date.now() / 1000;
      const fresh = (st.cookies ?? []).filter((c) => !c.expires || c.expires === -1 || c.expires > now);
      if (fresh.length) {
        await context.addCookies(fresh);
        한일.push(`저장된 쿠키 ${fresh.length}개 넣음`);
      }
    } catch {
      한일.push('저장된 쿠키가 깨져 있어 건너뜀');
    }
  }

  const 홈 = recipe.check?.url ?? recipe.baseUrl ?? recipe.loginUrl;
  await goTo(page, 홈).catch(() => {});
  await page.waitForTimeout(2_000);
  const 첫판정 = await 판정(page, context, recipe.check);
  if (첫판정.됐나 === true) {
    한일.push(`이미 로그인되어 있음 — 로그인 안 함 (${첫판정.어떻게})`);

    return 결과({ ok: true, 단계: '쿠키' });
  }

  // ── ③ 로그인 화면에서 값 넣기 ───────────────────────────────────────────
  //
  // **죽은 쿠키를 먼저 버립니다.** 오래된 쿠키를 그대로 둔 채 로그인하면
  // 마켓이 그 쿠키를 보고 `api/logout` 을 불러 방금 만든 세션까지 지워 버립니다
  // (실측 2026-08-02: 12시간 지난 쿠키를 넣었더니 그랬습니다).
  await context.clearCookies().catch(() => {});
  한일.push('죽은 쿠키를 버리고 처음부터 로그인합니다');

  const loginUrl = recipe.loginUrl.replace('{returnUrl}', encodeURIComponent(홈));
  await goTo(page, loginUrl);
  await page.waitForTimeout(2_000);

  for (const f of recipe.fields) {
    if (!f.value) {
      return 결과({ ok: false, 단계: '입력', 이유: `"${f.key}" 값이 표에 없습니다. 먼저 넣어 주세요.` });
    }
    const r = await act(page, { do: 'type', selectors: f.selectors, value: f.value });
    if (!r.ok) {
      return 결과({ ok: false, 단계: '입력', 이유: `"${f.key}" 칸에 못 넣었습니다: ${r.이유}` });
    }
    // **값은 안 적습니다.** 칸 이름과 글자 수만 남깁니다.
    한일.push(`${f.key} 넣음 (${f.value.length}글자)`);
  }

  // 자동입력 방지 문자는 **보내기 전에** 채웁니다. 실패한 로그인 시도를 만들지 않으려는 것입니다.
  const 방지 = await 방지문자채우기(page, recipe.captcha);
  if (방지 !== null) 한일.push(`자동입력 방지 문자에 아무 글자 ${방지}자 넣음 (이 마켓은 이 글자를 안 맞춰 봄)`);

  // ── ④ 보내기 ────────────────────────────────────────────────────────────
  if (!recipe.submit?.selectors?.length) {
    return 결과({ ok: false, 단계: '보내기', 이유: 'login_flow 에 submit 선택자가 없습니다.' });
  }
  const sent = await act(page, { do: 'click', selectors: recipe.submit.selectors, text: '로그인' });
  if (!sent.ok) {
    return 결과({ ok: false, 단계: '보내기', 이유: sent.이유 });
  }
  한일.push('로그인 버튼 누름');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  // ── ⑤ 확인. 방지 문자가 새로 떴으면 한 번만 더 채워서 보냅니다 ──────────
  if ((await 판정(page, context, recipe.check)).됐나 !== true) {
    const 다시 = await 방지문자채우기(page, recipe.captcha);
    if (다시 !== null) {
      한일.push(`방지 문자가 새로 떠서 다시 ${다시}자 넣고 한 번 더 보냄`);
      await act(page, { do: 'click', selectors: recipe.submit.selectors, text: '로그인' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
  }

  const 마지막 = await 판정(page, context, recipe.check);
  한일.push(`로그인 확인 — ${마지막.어떻게}`);
  const 됐나 = 마지막.됐나;
  if (됐나 !== true) {
    // 화면이 이유를 적어 뒀으면 그것을 그대로 가져옵니다. 우리가 지어내지 않습니다.
    let 화면말 = '';
    for (const sel of recipe.error?.selectors ?? []) {
      화면말 = await page.locator(sel).first().innerText({ timeout: 1_000 }).catch(() => '');
      if (화면말.trim()) break;
    }
    await shopware('/api/_action/cmh-ai/login/result', 'POST', {
      market,
      ok: false,
      message: 화면말.trim().slice(0, 200) || '로그인 확인 실패',
    }).catch(() => {});

    // 왜 안 됐는지는 **화면이 알고 있습니다.** 우리가 정해 둔 오류 자리에 안 적혀 있을 수 있으니
    // 화면 글자를 조금 그대로 담아 줍니다. 이걸 보고 다음에 무엇을 고칠지 정합니다.
    return 결과({
      ok: false,
      단계: '확인',
      이유: 화면말.trim() || '로그인이 안 됐습니다(마켓 API 가 아니라고 답했습니다).',
      화면: await 화면요약(page),
      사람필요: recipe.manual?.reason ?? '창에서 직접 로그인해 주세요.',
    });
  }

  // ── ⑥ 쿠키를 서버에 잠가서 저장 ─────────────────────────────────────────
  const state = JSON.stringify(await context.storageState());
  await shopware('/api/_action/cmh-ai/login/result', 'POST', {
    market,
    ok: true,
    message: '로그인 성공',
    storageState: state,
  });
  한일.push('로그인 쿠키를 서버에 잠가서 저장');

  return 결과({ ok: true, 단계: '확인' });
}
