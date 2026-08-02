import type { Page } from 'playwright-core';

/**
 * **화면 안에서** 그 사이트의 API 를 부릅니다.
 *
 * 왜 이 길이 필요한가 (2026-08-02 에 실제로 데인 것):
 * 선택자로 칸을 골라 값을 넣었는데, `div.form-sub-wrap:nth-of-type(1) ... input` 이
 * A/S 전화번호 칸이 아니라 **상품명 칸**에 걸렸습니다. 값은 정확히 들어갔고 확인도 통과했습니다.
 * **엉뚱한 칸에 정확히 넣고 성공이라고 답한 것입니다.**
 * API 로 하면 칸 이름(`product.detailAttribute.afterServiceInfo.afterServiceTelephoneNumber`)이
 * 정확해서 그런 일이 일어날 수가 없습니다. 접힌 영역·안내창·클릭 실패도 전부 없어집니다.
 *
 * **왜 브라우저 안에서 부르나 (Node 에서 직접 부르지 않고):**
 *  - 로그인 쿠키·CSRF 토큰·Referer 가 **화면이 가진 그대로** 실립니다. 따로 흉내 낼 필요가 없습니다.
 *  - 네이버가 보기에 **자기 화면이 부른 요청과 구별되지 않습니다.**
 *
 * **왜 값을 AI 에게 안 보내나:**
 *  상품 하나의 JSON 이 **500KB** 가 넘습니다(실측: TODO.md 에 붙여 둔 상품 한 건 = 524KB).
 *  읽고·고치고·되돌려 보내는 일을 AI 가 하면 그 500KB 가 두 번 오갑니다.
 *  그래서 **읽기·고치기·되돌려보내기를 이 도구 안에서 다 끝내고**, AI 에게는 바뀐 칸만 알려줍니다.
 */

export interface ApiCall {
  url: string;
  method?: string;
  /** 보낼 본문. 객체면 JSON 으로 보냅니다. */
  body?: unknown;
  /** 이 경로들만 뽑아서 돌려줍니다. 안 주면 전체(클 수 있음). 예: ["product.name","product.salePrice"] */
  pick?: string[];
}

export interface ApiResult {
  ok: boolean;
  status: number;
  url: string;
  /** pick 을 줬으면 뽑은 것만, 안 줬으면 전체. */
  data?: unknown;
  /** 본문이 커서 안 보낸 경우의 크기(바이트) */
  크기?: number;
  이유?: string;
}

/** "a.b.c" 또는 "a.b[0].c" 로 값 하나를 꺼냅니다. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** "a.b.c" 자리에 값을 넣습니다. 중간이 없으면 만들지 않고 실패로 알립니다. */
export function setPath(obj: unknown, path: string, value: unknown): boolean {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: unknown = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === null || typeof cur !== 'object') return false;
  (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
  return true;
}

/** 응답이 커도 AI 에게 통째로 보내지 않기 위한 한도(바이트). */
const MAX_BYTES = 20_000;

/** 화면 안에서 fetch 를 부릅니다. 쿠키·헤더는 화면이 가진 그대로 실립니다. */
async function fetchInPage(
  page: Page,
  url: string,
  method: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  try {
    return await page.evaluate(
      async ({ u, m, b }) => {
        const res = await fetch(u, {
          method: m,
          credentials: 'include',
          headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
          body: b === undefined ? undefined : JSON.stringify(b),
        });
        return { status: res.status, text: await res.text() };
      },
      { u: url, m: method, b: body },
    );
  } catch (e) {
    // **브라우저 규칙**: 화면 안의 fetch 는 **지금 열린 화면과 같은 도메인**만 부를 수 있습니다.
    // 다른 도메인이면 브라우저가 막고 "NetworkError" 만 던집니다(이유를 안 알려줍니다).
    // 실제 일에서는 문제가 안 됩니다 — 상품 화면에서 상품 API 를 부르는 식이라 도메인이 같습니다.
    const here = new URL(page.url()).host;
    const there = new URL(url, page.url()).host;
    if (here !== there) {
      throw new Error(
        `도메인이 다릅니다. 지금 화면은 "${here}" 인데 부르려는 곳은 "${there}" 입니다. ` +
          `브라우저가 막습니다. 먼저 browser_navigate 로 "${there}" 쪽 화면을 연 뒤 부르세요.`,
      );
    }
    throw e;
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

/** 뽑을 경로가 있으면 그것만, 없으면 크기를 보고 판단합니다. */
function shrink(data: unknown, pick?: string[]): Pick<ApiResult, 'data' | '크기'> {
  if (pick?.length) {
    const out: Record<string, unknown> = {};
    for (const p of pick) out[p] = getPath(data, p);
    return { data: out };
  }
  const bytes = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
  if (bytes > MAX_BYTES) {
    const keys = data && typeof data === 'object' ? Object.keys(data as object).slice(0, 30) : [];
    return {
      크기: bytes,
      data: {
        안내: `본문이 ${Math.round(bytes / 1024)}KB 라 통째로 안 보냅니다. pick 에 필요한 경로만 적어 다시 부르세요.`,
        맨위칸이름: keys,
      },
    };
  }
  return { data };
}

export async function apiCall(page: Page, q: ApiCall): Promise<ApiResult> {
  const method = (q.method ?? 'GET').toUpperCase();
  const { status, text } = await fetchInPage(page, q.url, method, q.body);
  const data = parse(text);
  return { ok: status >= 200 && status < 300, status, url: q.url, ...shrink(data, q.pick) };
}

export interface ApiPatch {
  /** 지금 값을 받아올 주소 */
  getUrl: string;
  /** 되돌려 보낼 주소. 안 주면 getUrl 과 같은 곳으로 보냅니다. */
  putUrl?: string;
  /** 되돌려 보낼 때 쓸 방식 (기본 PUT) */
  method?: string;
  /** 바꿀 칸. 경로 → 새 값. 예: {"product.detailAttribute...afterServiceTelephoneNumber": "+49 641 …"} */
  set: Record<string, unknown>;
  /** 참이면 보내지 않고 **무엇이 바뀔지만** 알려줍니다. 사람 승인을 받을 때 씁니다. */
  dryRun?: boolean;
}

export interface ApiPatchResult {
  ok: boolean;
  단계?: '읽기' | '바꾸기' | '보내기' | '되확인';
  /** 칸마다 지금 값 → 바꿀 값 */
  바뀜: { 경로: string; 지금: unknown; 바꿀값: unknown }[];
  보냄: boolean;
  status?: number;
  이유?: string;
}

/**
 * **읽고 · 한 칸만 바꾸고 · 되돌려 보내고 · 다시 읽어서 확인**합니다.
 *
 * 지키는 것 세 가지:
 *  1. **받은 JSON 을 그대로 되돌려 보냅니다.** 새로 만들지 않습니다.
 *     모르는 칸을 빠뜨리면 네이버 쪽 값이 지워질 수 있기 때문입니다.
 *  2. **없는 경로에는 값을 만들어 넣지 않습니다.** 오타로 엉뚱한 칸이 생기는 것을 막습니다.
 *  3. **보낸 뒤 다시 읽어서 대조합니다.** 화면 글자가 아니라 서버가 돌려준 값으로 확인합니다.
 */
export async function apiPatch(page: Page, q: ApiPatch): Promise<ApiPatchResult> {
  const 바뀜: ApiPatchResult['바뀜'] = [];

  // ① 지금 값을 통째로 받습니다.
  const got = await fetchInPage(page, q.getUrl, 'GET', undefined);
  if (got.status < 200 || got.status >= 300) {
    return { ok: false, 단계: '읽기', 바뀜, 보냄: false, status: got.status, 이유: '지금 값을 못 받았습니다.' };
  }
  const doc = parse(got.text);
  if (typeof doc !== 'object' || doc === null) {
    return { ok: false, 단계: '읽기', 바뀜, 보냄: false, 이유: '받은 것이 JSON 이 아닙니다.' };
  }

  // ② 적어 준 칸만 바꿉니다. 없는 경로면 멈춥니다.
  for (const [경로, 바꿀값] of Object.entries(q.set)) {
    const 지금 = getPath(doc, 경로);
    if (지금 === undefined) {
      return {
        ok: false,
        단계: '바꾸기',
        바뀜,
        보냄: false,
        이유: `"${경로}" 라는 칸이 없습니다. 오타이거나 화면이 바뀐 것입니다. 값을 만들어 넣지 않았습니다.`,
      };
    }
    바뀜.push({ 경로, 지금, 바꿀값 });
    if (!setPath(doc, 경로, 바꿀값)) {
      return { ok: false, 단계: '바꾸기', 바뀜, 보냄: false, 이유: `"${경로}" 에 값을 못 넣었습니다.` };
    }
  }

  // ③ 사람 승인을 기다리는 중이면 여기서 멈춥니다.
  if (q.dryRun) return { ok: true, 바뀜, 보냄: false };

  // ④ 받은 그대로 되돌려 보냅니다.
  const put = await fetchInPage(page, q.putUrl ?? q.getUrl, (q.method ?? 'PUT').toUpperCase(), doc);
  if (put.status < 200 || put.status >= 300) {
    return {
      ok: false,
      단계: '보내기',
      바뀜,
      보냄: true,
      status: put.status,
      이유: String(parse(put.text)).slice(0, 300),
    };
  }

  // ⑤ 다시 읽어서 진짜 바뀌었는지 봅니다. 화면 글자 말고 서버 응답으로 확인합니다.
  const again = parse((await fetchInPage(page, q.getUrl, 'GET', undefined)).text);
  const 안바뀐것 = 바뀜.filter((c) => JSON.stringify(getPath(again, c.경로)) !== JSON.stringify(c.바꿀값));
  if (안바뀐것.length) {
    return {
      ok: false,
      단계: '되확인',
      바뀜,
      보냄: true,
      status: put.status,
      이유: `보냈지만 그대로인 칸이 있습니다: ${안바뀐것.map((c) => c.경로).join(', ')}`,
    };
  }

  return { ok: true, 바뀜, 보냄: true, status: put.status };
}
