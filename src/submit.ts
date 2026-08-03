import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { act, type ActPlan, type ActResult } from './act.js';
import { getPath, setPath } from './api.js';
import { outDir, safeKey } from './dump.js';

/**
 * **저장 버튼을 코드가 누르되, 나가는 요청을 가로채서 통제합니다.**
 *
 * 왜 이렇게 하나 (2026-08-02 설계를 고침):
 * 처음에는 "저장은 사람이 눌러야 한다"고 만들었습니다. 그러면 자동화가 아닙니다.
 * 진짜 문제는 **누가 누르느냐**가 아니라 **네이버 서버에 값이 실제로 저장되느냐**입니다.
 * 그래서 누르기 전에 먼저 **가로채기를 걸어 둡니다.** 가로채기를 "막기"로 걸면
 * 버튼을 눌러도 요청이 네이버로 **안 갑니다** — 눌러도 아무것도 저장되지 않습니다.
 * 그 상태로 요청을 읽으면 "저장 요청이 어떻게 생겼나"를 **사람 없이 안전하게** 알아낼 수 있습니다.
 *
 * 그리고 값을 고칠 때도 화면의 입력칸을 찾아 넣지 않습니다. **나가는 요청 본문을 직접 고칩니다.**
 * 선택자가 엉뚱한 칸에 걸리는 사고(2026-08-02: A/S 전화번호를 상품명 칸에 넣음)가 원천적으로 없어집니다.
 *
 * 세 가지 방식만 있습니다.
 *   막기(block)  — 잡아서 **버립니다**. 네이버로 안 갑니다.        요청 모양 배우기 · 미리보기
 *   고치기(patch) — 잡아서 **값을 바꾼 뒤 보냅니다**.               실제 저장 (승인 뒤에)
 *   그대로(send) — 잡아서 **보고만 하고 그대로 보냅니다**.          화면에 넣은 값 그대로 저장
 */

/** 값을 바꾸는 방식들. 이것만 가로챕니다 — GET 까지 잡으면 화면이 안 뜹니다. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** AI 에게 통째로 보낼 수 있는 최대 크기. 상품 저장 본문은 500KB 가 넘습니다. */
const MAX_INLINE_BYTES = 8_000;

/** 한 번에 잡아 둘 요청 수. 저장 한 번에 요청이 여러 개 나갈 수 있습니다. */
const MAX_CAUGHT = 5;

export type SubmitMode = 'block' | 'patch' | 'send';

export interface SubmitPlan {
  /**
   * 무엇을 가로챌지. 주소 무늬(glob)입니다. 예: `**\/api/v1/products/**`
   * DB(`cmh_ai_endpoint.urlPattern`)에 있는 것을 그대로 쓰면 됩니다.
   */
  urlPattern: string;
  mode: SubmitMode;
  /** 저장을 일으키는 누르기. browser_act 와 같은 모양입니다. */
  click: ActPlan;
  /** mode:'patch' 일 때 바꿀 값. `{"product.name":"새 이름"}` — 없는 경로면 만들지 않고 알려줍니다. */
  set?: Record<string, unknown>;
  /** 요청이 나갈 때까지 기다릴 시간(ms). 기본 15초 */
  waitMs?: number;
  /** 잡은 본문을 이 이름으로 파일에 남깁니다(영문·숫자·-·_). 안 주면 안 남깁니다. */
  saveAs?: string;
}

interface Caught {
  method: string;
  url: string;
  bytes: number;
  /** 맨 위 칸 이름. 본문이 커서 통째로 못 볼 때 이것만으로도 모양을 압니다. */
  맨위칸이름?: string[];
  /** 작으면 본문 그대로. */
  본문?: unknown;
  /** mode:'patch' 에서 실제로 바뀐 것. */
  바꾼것?: Array<{ 경로: string; 전: unknown; 후: unknown }>;
  /** 바꾸려 했는데 그 경로가 본문에 없던 것. **값을 새로 만들지 않습니다.** */
  경로없음?: string[];
  처리: '버림' | '고쳐서 보냄' | '그대로 보냄';
}

export interface SubmitResult {
  ok: boolean;
  mode: SubmitMode;
  /** 눌렀는가 (browser_act 의 결과 그대로) */
  누르기: ActResult;
  잡은요청: Caught[];
  /** 본문을 파일로 남겼으면 그 경로. grep 으로 찾아보면 됩니다. */
  파일?: string[];
  /**
   * 요청이 하나도 안 나갔을 때 화면에 떠 있던 글자(앞부분만).
   * **왜 안 나갔는지는 화면이 알고 있습니다** — 대개 "필수값을 입력하세요" 같은 안내창입니다.
   */
  화면?: string;
  안내: string;
}

/** 본문을 파일로 남깁니다. 500KB 를 AI 에게 보내는 대신 여기서 찾게 합니다. */
function dumpBody(saveAs: string, index: number, method: string, url: string, body: string): string {
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeKey(saveAs)}.request-${index}.json`);
  fs.writeFileSync(file, JSON.stringify({ method, url, body: safeParse(body) }, null, 2), 'utf8');
  return file;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function submit(page: Page, plan: SubmitPlan): Promise<SubmitResult> {
  const caught: Caught[] = [];
  const files: string[] = [];
  let 첫요청알림: (() => void) | null = null;
  const 첫요청 = new Promise<void>((resolve) => {
    첫요청알림 = resolve;
  });

  const handler = async (route: Route): Promise<void> => {
    const req = route.request();

    // 값을 바꾸는 요청만 다룹니다. 화면이 자료를 읽으려고 부르는 GET 까지 막으면 화면이 안 뜹니다.
    if (!WRITE_METHODS.has(req.method()) || caught.length >= MAX_CAUGHT) {
      await route.continue().catch(() => {});
      return;
    }

    const raw = req.postData() ?? '';
    const bytes = Buffer.byteLength(raw, 'utf8');
    const parsed = safeParse(raw);
    const isObj = parsed !== null && typeof parsed === 'object';

    const one: Caught = {
      method: req.method(),
      url: req.url(),
      bytes,
      처리: plan.mode === 'block' ? '버림' : plan.mode === 'patch' ? '고쳐서 보냄' : '그대로 보냄',
    };
    if (isObj) one.맨위칸이름 = Object.keys(parsed as object).slice(0, 40);
    if (bytes <= MAX_INLINE_BYTES) one.본문 = parsed;

    if (plan.saveAs && raw) {
      files.push(dumpBody(plan.saveAs, caught.length + 1, req.method(), req.url(), raw));
    }

    let 보낼본문 = raw;

    if (plan.mode === 'patch' && plan.set && isObj) {
      const 바꾼것: Caught['바꾼것'] = [];
      const 없음: string[] = [];
      for (const [p, v] of Object.entries(plan.set)) {
        const 전 = getPath(parsed, p);
        // **없는 경로는 만들지 않습니다.** 만들면 네이버가 모르는 칸이 생겨서 통째로 거부당하거나,
        // 더 나쁘게는 조용히 무시된 채 "저장했다" 고 답하게 됩니다.
        if (setPath(parsed, p, v)) 바꾼것.push({ 경로: p, 전, 후: v });
        else 없음.push(p);
      }
      one.바꾼것 = 바꾼것;
      if (없음.length) one.경로없음 = 없음;
      보낼본문 = JSON.stringify(parsed);
    }

    caught.push(one);
    첫요청알림?.();

    if (plan.mode === 'block') {
      await route.abort().catch(() => {});
      return;
    }
    // Content-Length 는 Playwright 가 다시 셉니다. 우리가 손대면 오히려 어긋납니다.
    await route.continue({ postData: 보낼본문 }).catch(() => {});
  };

  await page.route(plan.urlPattern, handler);
  let 누르기: ActResult;
  try {
    누르기 = await act(page, plan.click);
    // 누르고 나서 요청이 나가기까지 잠깐 걸립니다. 첫 요청이 잡히거나 시간이 다 될 때까지 기다립니다.
    await Promise.race([첫요청, new Promise((r) => setTimeout(r, plan.waitMs ?? 15_000))]);
    // 저장 한 번에 요청이 여러 개 나가는 경우가 있어 잠깐 더 봅니다.
    if (caught.length) await new Promise((r) => setTimeout(r, 1_500));
  } finally {
    // **반드시 풉니다.** 안 풀면 다음 작업에서 저장이 계속 막혀서, 왜 안 되는지 아무도 모릅니다.
    await page.unroute(plan.urlPattern, handler).catch(() => {});
  }

  const 안내 =
    caught.length === 0
      ? 누르기.ok
        ? `눌렀지만 "${plan.urlPattern}" 에 맞는 저장 요청이 안 나갔습니다. ` +
          '무늬가 틀렸거나(주소를 browser_network_requests 로 확인하세요), 화면이 먼저 막았을 수 있습니다(필수값 등).'
        : '누르지 못해서 아무 요청도 안 나갔습니다. 누르기 결과의 이유를 보세요.'
      : plan.mode === 'block'
        ? `요청 ${caught.length}건을 잡아서 **버렸습니다. 네이버에는 아무것도 안 갔습니다.** ` +
          '화면에 저장 실패 안내가 뜰 수 있는데, 그건 우리가 막았기 때문입니다 — 고장이 아닙니다.'
        : plan.mode === 'patch'
          ? `요청 ${caught.length}건의 본문을 고쳐서 네이버로 보냈습니다. **실제로 저장됩니다.**`
          : `요청 ${caught.length}건을 그대로 네이버로 보냈습니다. **실제로 저장됩니다.**`;

  // 요청이 안 나갔으면 **화면을 그대로 담아 줍니다.** 대개 화면이 먼저 막은 것이고,
  // 왜 막았는지는 화면에 적혀 있습니다("필수 항목을 입력해 주세요" 같은 안내창).
  const 화면 =
    caught.length === 0
      ? await page
          .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500))
          .catch(() => '')
      : '';

  return {
    ok: caught.length > 0 && 누르기.ok,
    mode: plan.mode,
    누르기,
    잡은요청: caught,
    ...(files.length ? { 파일: files } : {}),
    ...(화면 ? { 화면 } : {}),
    안내,
  };
}
