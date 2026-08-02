import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { act } from './act.js';
import { apiCall, apiPatch } from './api.js';
import { closeBrowser, current, openBrowser, status } from './browser.js';
import { importChromeCookies, importFirefoxCookies } from './cookies.js';
import { outDir, writeDump } from './dump.js';
import { extractFromHtml } from './extract.js';
import { assertWebUrl } from './guard.js';
import { closeLayerPopups } from './popup.js';
import { contentTarget, snapshotBoth } from './frame.js';
import { locate } from './locate.js';
import { login } from './login.js';
import { snapshot } from './snapshot.js';
import { submit } from './submit.js';

const server = new McpServer({ name: 'camoufox-mcp', version: '0.1.0' });

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});


server.registerTool(
  'browser_open',
  {
    title: '브라우저 열기',
    description:
      'Camoufox(스텔스 파이어폭스) 창을 띄웁니다. 창이 보이므로 사람이 같이 볼 수 있고, ' +
      '마우스는 브라우저 안에서만 움직이므로 사용자의 다른 작업을 방해하지 않습니다. ' +
      '로그인 상태는 프로필 폴더에 남아 다음에도 유지됩니다.',
    inputSchema: {
      blockImages: z
        .boolean()
        .optional()
        .describe('이미지 차단(기본 false). 화면을 조사할 때는 false 로 두세요.'),
      proxy: z.string().optional().describe('프록시 주소. 회전형은 세션이 끊기니 쓰지 마세요.'),
    },
  },
  async ({ blockImages, proxy }) => {
    const r = await openBrowser({ blockImages, proxy });
    return text({
      reused: r.reused,
      ...status(),
      안내: r.reused ? '이미 열린 창을 그대로 씁니다.' : '창을 새로 띄웠습니다.',
    });
  },
);

server.registerTool(
  'browser_status',
  { title: '브라우저 상태', description: '창이 열려 있는지, 지금 어떤 브라우저가 실행 중인지 봅니다.', inputSchema: {} },
  async () => text(status()),
);

server.registerTool(
  'browser_close',
  { title: '브라우저 닫기', description: '창을 닫고 메모리를 반납합니다.', inputSchema: {} },
  async () => text({ closed: await closeBrowser() }),
);

server.registerTool(
  'browser_cookies_import',
  {
    title: '로컬 브라우저 쿠키 가져오기',
    description:
      '사용자가 쓰던 브라우저의 로그인 쿠키를 복사해 넣습니다. 로그인을 새로 안 해도 됩니다. ' +
      '파이어폭스는 됩니다. 크롬은 아직 안 됩니다(App-Bound 암호화).',
    inputSchema: {
      source: z.enum(['firefox', 'chrome']).describe('어느 브라우저에서 가져올지'),
      domain: z
        .string()
        .describe(
          '가져올 도메인 (예: naver.com). 필수입니다 — 비우면 은행·메일 쿠키까지 전부 딸려옵니다.',
        ),
    },
  },
  async ({ source, domain }) => {
    const { context } = current();
    const r = source === 'firefox' ? await importFirefoxCookies(context, domain) : await importChromeCookies();
    return text(r);
  },
);

server.registerTool(
  'browser_navigate',
  {
    title: '페이지 이동',
    description: '주소로 이동하고 화면이 다 뜰 때까지 기다립니다.',
    inputSchema: {
      url: z.string().describe('이동할 주소'),
      waitForText: z.string().optional().describe('이 글자가 보일 때까지 기다림'),
      timeoutMs: z.number().optional().describe('최대 대기(기본 45000)'),
      closePopups: z
        .boolean()
        .optional()
        .describe('알림창 자동 정리(기본 켬). "하루 동안 보이지 않기" 체크 후 닫습니다'),
    },
  },
  async ({ url, waitForText, timeoutMs, closePopups }) => {
    const { page } = current();
    const timeout = timeoutMs ?? 45_000;
    await page.goto(assertWebUrl(url), { waitUntil: 'domcontentloaded', timeout });
    // SPA 는 주소만 바뀌고 내용은 나중에 옵니다. 그래서 조용해질 때까지 한 번 더 기다립니다.
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    if (waitForText) {
      await page.getByText(waitForText, { exact: false }).first().waitFor({ timeout }).catch(() => {});
    }
    const popups = closePopups === false ? null : await closeLayerPopups(page);
    return text({ url: page.url(), title: await page.title(), popups });
  },
);

server.registerTool(
  'browser_close_popups',
  {
    title: '알림창 닫기',
    description:
      '화면에 뜬 알림창을 정리합니다. "하루 동안 보이지 않기"를 체크한 뒤 닫고, ' +
      '진짜 사라졌는지까지 확인합니다. 못 닫은 것은 따로 알려줍니다.',
    inputSchema: {},
  },
  async () => {
    const { page } = current();
    return text(await closeLayerPopups(page));
  },
);

server.registerTool(
  'browser_wait_for',
  {
    title: '기다리기',
    description: '글자가 나타날 때까지, 또는 정해진 시간만큼 기다립니다.',
    inputSchema: {
      forText: z.string().optional(),
      ms: z.number().optional(),
      timeoutMs: z.number().optional(),
    },
  },
  async ({ forText, ms, timeoutMs }) => {
    const { page } = current();
    if (forText) {
      await page.getByText(forText, { exact: false }).first().waitFor({ timeout: timeoutMs ?? 30_000 });
    }
    if (ms) await page.waitForTimeout(ms);
    return text({ ok: true, url: page.url() });
  },
);

server.registerTool(
  'browser_snapshot',
  {
    title: '화면 요소 뽑기',
    description:
      '화면 요소를 뽑습니다. **find 로 걸러서 부르세요** — 안 거르면 400개가 통째로 와서 응답이 150KB 가 됩니다. ' +
      '거르기는 브라우저 안에서 하므로 걸린 것만 옵니다. ' +
      '누를 것을 이미 아는 경우에는 이걸 부르지 말고 browser_click({text}) 을 바로 쓰세요.',
    inputSchema: {
      find: z.string().optional().describe('이 글자가 든 것만 (예: "저장"). 제일 먼저 이걸 쓰세요.'),
      only: z.enum(['click', 'input', 'all']).optional().describe('click=누를 것 · input=값 넣을 것'),
      limit: z.number().optional().describe('최대 개수(기본 400, find 를 주면 20 이면 충분)'),
      verbose: z.boolean().optional().describe('선택자를 전부 담기(기본은 위에서 2개만)'),
    },
  },
  async ({ find, only, limit, verbose }) => {
    const { page } = current();
    const r = await snapshotBoth(page, { limit: limit ?? (find ? 20 : 400), find, only, verbose }, snapshot);
    return text(r);
  },
);

server.registerTool(
  'browser_network_requests',
  {
    title: '화면이 부른 JSON 목록',
    description:
      '창이 열린 뒤 오간 XHR/JSON 목록입니다. 본문은 빼고 목록만 봅니다.\n' +
      '**onlyWrites:true 로 부르면 값을 바꾼 요청(POST·PUT·PATCH·DELETE)만** 나옵니다 — ' +
      '"저장을 누르면 무엇이 어디로 가는가"를 볼 때 이걸 쓰세요.',
    inputSchema: {
      filter: z.string().optional().describe('URL 에 이 글자가 든 것만'),
      onlyWrites: z.boolean().optional().describe('값을 바꾼 요청만 (저장·발송·삭제)'),
    },
  },
  async ({ filter, onlyWrites }) => {
    const { recorder } = current();
    return text(onlyWrites ? recorder.writes(filter) : recorder.list(filter));
  },
);

server.registerTool(
  'browser_network_body',
  {
    title: 'JSON 본문 보기',
    description:
      'network_requests 에서 고른 ref 하나를 통째로 봅니다. ' +
      '**받은 것(body)과 보낸 것(sent)이 둘 다** 들어 있습니다.',
    inputSchema: { ref: z.number().describe('network_list 의 ref 번호') },
  },
  async ({ ref }) => {
    const { recorder } = current();
    const e = recorder.get(ref);
    return text(e ?? { error: `ref ${ref} 를 못 찾았습니다.` });
  },
);

server.registerTool(
  'browser_api',
  {
    title: 'API 부르기 (화면 안에서)',
    description:
      '지금 열린 화면의 **로그인 상태 그대로** 그 사이트의 API 를 부릅니다. 화면 글자를 긁는 것보다 빠르고 안 깨집니다.\n' +
      '⚠️ **지금 열린 화면과 같은 도메인만** 부를 수 있습니다(브라우저 규칙). 다르면 먼저 browser_navigate 하세요.\n' +
      '**pick 에 필요한 경로만 적으세요** — 상품 하나의 JSON 이 500KB 가 넘습니다.\n' +
      '예: {url:"https://sell.smartstore.naver.com/api/products/123", pick:["product.name","product.salePrice"]}',
    inputSchema: {
      url: z.string().describe('부를 주소'),
      method: z.string().optional().describe('기본 GET'),
      body: z.unknown().optional().describe('보낼 본문(객체면 JSON 으로 보냄)'),
      pick: z
        .array(z.string())
        .optional()
        .describe('뽑을 경로만. 예: ["product.name"]. 안 주면 20KB 넘을 때 칸 이름만 옵니다.'),
    },
  },
  async ({ url, method, body, pick }) => {
    const { page } = current();
    assertWebUrl(url);
    return text(await apiCall(page, { url, method, body, pick }));
  },
);

server.registerTool(
  'browser_api_patch',
  {
    title: '값 고치기 (읽고 · 한 칸만 바꾸고 · 되확인)',
    description:
      '**칸에 타자를 치는 대신 이것을 쓰세요.** 선택자로 칸을 고르면 엉뚱한 칸에 들어갈 수 있습니다(2026-08-02 실제 사고).\n' +
      '하는 일: ① 지금 값을 통째로 받고 ② 적어 준 칸만 바꾸고 ③ 받은 그대로 되돌려 보내고 ④ 다시 읽어서 대조합니다.\n' +
      '**사람 승인을 받기 전에는 반드시 dryRun:true 로 부르세요.** 무엇이 바뀔지만 알려주고 보내지 않습니다.\n' +
      '없는 경로를 적으면 값을 만들지 않고 멈춥니다.',
    inputSchema: {
      getUrl: z.string().describe('지금 값을 받아올 주소'),
      putUrl: z.string().optional().describe('되돌려 보낼 주소(기본: getUrl 과 같은 곳)'),
      method: z.string().optional().describe('되돌려 보낼 방식(기본 PUT)'),
      set: z.record(z.unknown()).describe('바꿀 칸. 경로 → 새 값'),
      dryRun: z.boolean().optional().describe('참이면 보내지 않고 무엇이 바뀔지만 알려줍니다'),
    },
  },
  async ({ getUrl, putUrl, method, set, dryRun }) => {
    const { page } = current();
    assertWebUrl(getUrl);
    if (putUrl) assertWebUrl(putUrl);
    return text(await apiPatch(page, { getUrl, putUrl, method, set, dryRun }));
  },
);

server.registerTool(
  'browser_act',
  {
    title: '하고 · 확인하기 (DB 선택자용)',
    description:
      '**DB 에 저장된 선택자로 일할 때 이것을 쓰세요.** browser_click 과 달리 세 가지를 더 합니다.\n' +
      '① 선택자 후보를 1순위부터 써 보고, **여러 개가 걸리면 찍지 않고 멈춥니다**.\n' +
      '② 하고 나서 **기대한 결과가 됐는지 확인**합니다 (팝업 닫힘 · 주소 바뀜 · "저장되었습니다" 뜸 …).\n' +
      '③ 안 되면 **왜 안 됐는지와 지금 화면의 비슷한 것 몇 개만** 돌려줍니다. 그걸 보고 고쳐서 다시 부르세요.\n' +
      '예: {do:"click", selectors:["#save"], text:"저장하기", expect:{appears:"저장되었습니다"}}',
    inputSchema: {
      do: z.enum(['click', 'type']).describe('누르기 · 값 넣기'),
      selectors: z.array(z.string()).optional().describe('DB 가 준 선택자 후보. 1순위부터'),
      text: z.string().optional().describe('선택자가 다 안 될 때 쓸 글자'),
      value: z.string().optional().describe("do:'type' 일 때 넣을 값"),
      expect: z
        .object({
          gone: z.string().optional().describe('이 글자가 사라져야 함 (팝업 닫기)'),
          appears: z.string().optional().describe('이 글자가 나타나야 함 (팝업 열기 · 저장 완료)'),
          urlChanged: z.boolean().optional().describe('주소가 바뀌어야 함 (페이지 이동)'),
          checked: z.boolean().optional().describe('체크 상태가 이렇게 되어야 함'),
          value: z.string().optional().describe('칸의 값이 이렇게 되어야 함'),
          timeoutMs: z.number().optional().describe('확인까지 기다릴 시간(기본 8초)'),
        })
        .optional()
        .describe('하고 나서 이렇게 되어야 한다. 안 넣으면 결과를 확인하지 않습니다.'),
    },
  },
  async (plan) => {
    const { page } = current();
    return text(await act(page, plan));
  },
);

server.registerTool(
  'browser_login',
  {
    title: '마켓에 로그인',
    description:
      '마켓(네이버 등)에 로그인합니다. **비밀번호를 주지 마세요 — 줄 수도 없습니다.** ' +
      '샵웨어 서버가 잠가 둔 비밀번호를 풀어서 이 서버로만 보내고, 여기서 바로 화면에 칩니다. ' +
      'AI 에게는 됐다/안 됐다와 이유만 옵니다.\n' +
      '이미 로그인되어 있으면 아무것도 안 하고 바로 끝냅니다. 성공하면 쿠키를 서버에 잠가서 저장합니다.',
    inputSchema: {
      market: z.string().describe('마켓 코드 (예: naver_smartstore). 도메인이나 업무분야 코드도 됩니다.'),
    },
  },
  async ({ market }) => {
    const { page, context } = current();
    return text(await login(page, context, market));
  },
);

server.registerTool(
  'browser_submit',
  {
    title: '저장 누르고 나가는 요청 가로채기',
    description:
      '**저장·발송처럼 값을 바꾸는 버튼은 browser_click 말고 이것을 쓰세요.**\n' +
      '누르기 전에 먼저 가로채기를 걸어서, 나가는 요청을 잡습니다. 세 가지 방식이 있습니다.\n' +
      '① mode:"block" — 잡아서 **버립니다. 네이버로 안 갑니다.** 눌러도 아무것도 저장되지 않습니다.\n' +
      '   → **저장 요청이 어떻게 생겼는지 알아낼 때 이걸 씁니다.** 안전합니다. 사람이 필요 없습니다.\n' +
      '② mode:"patch" — 잡아서 **본문의 값을 바꾼 뒤 보냅니다. 실제로 저장됩니다.**\n' +
      '   → 화면의 입력칸을 안 찾으므로 **엉뚱한 칸에 넣는 사고가 없습니다.**\n' +
      '③ mode:"send" — 잡아서 보고만 하고 **그대로 보냅니다. 실제로 저장됩니다.**\n' +
      '\n' +
      '**patch·send 는 사람이 승인한 뒤에만 부르세요** (market_approval_hold → 승인 → 여기).\n' +
      '예: {urlPattern:"**/api/v1/products/**", mode:"block", click:{do:"click", text:"저장하기"}, saveAs:"product-save"}',
    inputSchema: {
      urlPattern: z
        .string()
        .describe('가로챌 주소 무늬(glob). 예: "**/api/v1/products/**". DB 의 cmh_ai_endpoint.urlPattern 을 그대로 쓰세요.'),
      mode: z
        .enum(['block', 'patch', 'send'])
        .describe('block=버림(안 저장됨) · patch=값 바꿔 보냄(저장됨) · send=그대로 보냄(저장됨)'),
      click: z
        .object({
          do: z.enum(['click', 'type']),
          selectors: z.array(z.string()).optional(),
          text: z.string().optional(),
          value: z.string().optional(),
        })
        .describe('저장을 일으키는 누르기. browser_act 와 같은 모양입니다.'),
      set: z
        .record(z.unknown())
        .optional()
        .describe('mode:"patch" 일 때 바꿀 값. {"product.name":"새 이름"}. 본문에 없는 경로는 만들지 않고 알려줍니다.'),
      waitMs: z.number().optional().describe('요청이 나갈 때까지 기다릴 시간(기본 15초)'),
      saveAs: z
        .string()
        .optional()
        .describe('잡은 본문을 파일로 남길 이름(영문·숫자·-·_). 본문이 500KB 여도 파일에서 찾아보면 됩니다.'),
    },
  },
  async (plan) => {
    const { page } = current();
    return text(await submit(page, plan));
  },
);

server.registerTool(
  'browser_click',
  {
    title: '클릭',
    description:
      '사람처럼(곡선 마우스) 클릭합니다. **글자만 주면 됩니다** — snapshot 을 먼저 부를 필요가 없습니다. ' +
      '예: {text:"저장하기"}. 같은 글자가 여럿이면 nth 로 고릅니다. ' +
      'iframe 안쪽도 같이 찾습니다.',
    inputSchema: {
      text: z.string().optional().describe('버튼·링크·칸의 글자 (제일 흔한 길)'),
      ref: z.string().optional().describe('snapshot 이 준 ref (예: e12)'),
      selector: z.string().optional().describe('CSS 선택자를 직접 줄 때'),
      nth: z.number().optional().describe('같은 것이 여럿일 때 몇 번째 (0부터)'),
      timeoutMs: z.number().optional(),
    },
  },
  async ({ text: q, ref, selector, nth, timeoutMs }) => {
    const { page } = current();
    const found = await locate(page, { ref, text: q, selector, nth });
    const el = found.locator;
    let how = found.how;
    // 체크박스는 누르기 전 상태를 기억해 둡니다. 눌렀는데 안 바뀌면 **실패로 알려야** 하기 때문입니다.
    // 실측(2026-07-31): 좌표 클릭이 "눌렀다"고 답했지만 실제로는 하나도 안 바뀌었습니다.
    // 그대로 저장했으면 "고쳤다"고 잘못 보고할 뻔했습니다.
    const before = await el.isChecked().catch(() => null);

    try {
      // 사람처럼 움직이는 마우스는 한 번 누르는 데 1~5초가 걸립니다(2026-08-01 실측).
      // 짧게 끊으면 멀쩡한 클릭이 죽고, 빗나갈 수 있는 좌표 클릭으로 떨어집니다.
      await el.click({ timeout: timeoutMs ?? 20_000 });
    } catch (e) {
      // 화면을 계속 다시 그리는 사이트에서는 "요소가 멈출 때까지" 기다림이 안 끝납니다.
      // 먼저 화면 안으로 끌어온 뒤, **요소를 집은 채로** 안전장치만 끕니다(force).
      // 좌표 클릭보다 훨씬 안전합니다 — 스크롤이 어긋나도 엉뚱한 곳을 누르지 않습니다.
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      try {
        await el.click({ force: true, timeout: 5_000 });
        how += ' + force';
      } catch {
        const box = await el.boundingBox().catch(() => null);
        if (!box) throw e;
        // 마지막 수단. 스크롤이 움직이면 빗나갈 수 있으므로 아래에서 반드시 확인합니다.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        how += ' + 좌표(빗나갈 수 있음)';
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const after = before === null ? null : await el.isChecked().catch(() => null);
    const out: Record<string, unknown> = { clicked: q ?? ref ?? selector, how, url: page.url() };
    // 같은 조건에 여러 개가 걸렸으면 그중 하나를 고른 것입니다. 조용히 넘기면 엉뚱한 것을 눌러 놓고
    // "눌렀다"고 답하게 됩니다.
    if (found.matches > 1) {
      out.겹침 = `같은 조건에 ${found.matches}개가 걸려서 ${nth ?? 0}번째를 눌렀습니다. 다른 것이면 nth 를 바꾸세요.`;
    }
    if (before !== null) {
      out.checked = after;
      // 눌렀는데 그대로면 조용히 넘기지 않습니다. 부르는 쪽이 알아야 합니다.
      if (before === after) out.경고 = '눌렀지만 체크 상태가 그대로입니다. 라벨을 눌러야 하는 칸일 수 있습니다.';
    }
    return text(out);
  },
);

server.registerTool(
  'browser_type',
  {
    title: '입력',
    description:
      '칸을 클릭하고 사람처럼 한 글자씩 칩니다. **칸 이름·placeholder 글자만 주면 됩니다** — snapshot 불필요. ' +
      '예: {text:"상품명 검색", value:"브리오"}. ' +
      'Camoufox 는 마우스만 사람처럼 움직이므로 타이핑 간격은 여기서 줍니다.',
    inputSchema: {
      text: z.string().optional().describe('칸의 이름표나 placeholder 글자'),
      ref: z.string().optional().describe('snapshot 이 준 ref'),
      selector: z.string().optional().describe('CSS 선택자를 직접 줄 때'),
      nth: z.number().optional(),
      value: z.string(),
      delayMs: z.number().optional().describe('글자 사이 간격(기본 60~140 무작위)'),
      clear: z.boolean().optional().describe('기존 값을 지우고 입력(기본 true)'),
      submit: z.boolean().optional().describe('입력 후 Enter'),
    },
  },
  async ({ text: q, ref, selector, nth, value, delayMs, clear, submit }) => {
    const { page } = current();
    const found = await locate(page, { ref, text: q, selector, nth });
    const el = found.locator;
    await el.click();
    if (clear !== false) await el.fill('');
    // 사람은 일정한 속도로 치지 않습니다. 그래서 글자마다 간격을 조금씩 흔듭니다.
    for (const ch of value) {
      await el.pressSequentially(ch, { delay: delayMs ?? 60 + Math.floor(Math.random() * 80) });
    }
    if (submit) await el.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const out: Record<string, unknown> = {
      typed: q ?? ref ?? selector,
      how: found.how,
      submitted: !!submit,
      url: page.url(),
    };
    if (found.matches > 1) {
      out.겹침 = `같은 조건에 ${found.matches}개가 걸려서 ${nth ?? 0}번째 칸에 넣었습니다. 다른 칸이면 nth 를 바꾸세요.`;
    }
    return text(out);
  },
);

server.registerTool(
  'browser_take_screenshot',
  {
    title: '화면 사진',
    description: '지금 화면을 그림으로 남깁니다. 조사 근거로 씁니다.',
    inputSchema: { fullPage: z.boolean().optional() },
  },
  async ({ fullPage }) => {
    const { page } = current();
    const buf = await page.screenshot({ fullPage: fullPage ?? false, type: 'png' });
    return {
      content: [{ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' }],
    };
  },
);

server.registerTool(
  'browser_page_dump',
  {
    title: '조사 결과 저장',
    description:
      '지금 화면의 요소 + 부른 JSON 을 파일 두 개로 남깁니다. ' +
      '.json 은 나중에 DB 에 넣을 원본, .md 는 사람이 읽고 같이 검토할 문서입니다.',
    inputSchema: {
      menuKey: z.string().describe('파일 이름 (예: product-list)'),
      menuPath: z.string().optional().describe('사람이 읽는 메뉴 경로 (예: 상품관리 > 상품조회/수정)'),
      note: z.string().optional().describe('메모'),
      netFilter: z.string().optional().describe('저장할 JSON 을 URL 로 거를 때'),
      limit: z.number().optional().describe('요소 최대 개수(기본 1500)'),
      maskPii: z
        .boolean()
        .optional()
        .describe('개인정보 가리기. 기본은 켜짐. 고객 자료가 없는 화면에서만 false 로 끄세요.'),
    },
  },
  async ({ menuKey, menuPath, note, netFilter, limit, maskPii }) => {
    const { page, recorder } = current();
    // 두 가지 방식을 함께 씁니다. 서로 못 보는 걸 채워줍니다.
    //  - snapshot: 브라우저 안에서 잼 → 지금 보이는지, 클릭되는지 (ref 로 집을 수 있음)
    //  - extract  : 다 그려진 HTML 을 cheerio 로 훑음 → 글 내용, select 선택지, 표 머리글
    const snap = await snapshotBoth(page, { limit: limit ?? 1500, verbose: true }, snapshot);
    const extracted = extractFromHtml(await (await contentTarget(page)).target.content(), page.url());
    const all = recorder.all();
    const net = netFilter ? all.filter((e) => e.url.includes(netFilter)) : all;
    const files = writeDump({
      menuKey, menuPath, note, snap, net, extract: extracted,
      // 주문·고객 화면이면 개인정보를 가리고 저장합니다.
      // ⚠️ 예전에는 주소에 `naverpay|order|...` 가 들어갈 때만 가렸습니다. 두 가지가 잘못이었습니다.
      //   1) `maskPii: true` 를 넘겨도 주소가 안 맞으면 **켜지지 않았습니다**(끄기만 되는 값이었음).
      //   2) 고객 자료가 있는지는 **주소가 아니라 받은 내용**이 정합니다.
      //      실측: 대시보드(`#/home/dashboard`)는 주소에 아무 낱말도 없지만 문의 목록에 고객 이름이 옵니다.
      // 그래서 **기본을 켬**으로 바꿉니다. 끄려면 일부러 false 를 넘겨야 합니다.
      maskPii: maskPii ?? true,
    });
    return text({
      ...files,
      요소: snap.elements.length,
      입력칸: extracted.fields.length,
      선택상자: extracted.fields.filter((f) => f.options?.length).length,
      API: net.length,
      표: extracted.tables.length,
      본문: extracted.stats.dropRatio,
      다음: 'md 파일 맨 아래 "이 화면에서 할 수 있는 일" 표를 사람과 상의해서 채우세요.',
    });
  },
);

server.registerTool(
  'browser_extract',
  {
    title: '화면을 글로 바꾸기',
    description:
      '지금 화면을 마크다운 글로 바꾸고, 입력칸·선택지·표 구조를 뽑습니다. ' +
      '요소 목록 전체보다 훨씬 짧아서, 이 화면이 무슨 화면인지 빠르게 파악할 때 씁니다. ' +
      '저장은 하지 않습니다(저장은 browser_page_dump).',
    inputSchema: {
      what: z
        .enum(['all', 'content', 'fields', 'tables', 'links'])
        .optional()
        .describe('필요한 부분만 받으면 더 짧습니다 (기본 all)'),
    },
  },
  async ({ what }) => {
    const { page } = current();
    const r = extractFromHtml(await (await contentTarget(page)).target.content(), page.url());
    if (what === 'content') return text(r.markdown);
    if (what === 'fields') return text({ fields: r.fields });
    if (what === 'tables') return text({ tables: r.tables });
    if (what === 'links') return text({ links: r.links });
    return text(r);
  },
);

server.registerTool(
  'browser_network_clear',
  {
    title: 'JSON 기록 비우기',
    description: '다음 화면을 깨끗하게 조사하려고 지금까지 모은 기록을 지웁니다.',
    inputSchema: {},
  },
  async () => {
    const { recorder } = current();
    recorder.clear();
    return text({ cleared: true });
  },
);

process.stderr.write(`[camoufox-mcp] 결과 저장 위치: ${outDir()}\n`);

await server.connect(new StdioServerTransport());
