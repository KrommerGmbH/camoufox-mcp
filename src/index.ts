import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeBrowser, current, openBrowser, status } from './browser.js';
import { importChromeCookies, importFirefoxCookies } from './cookies.js';
import { outDir, writeDump } from './dump.js';
import { assertWebUrl } from './guard.js';
import { byRef, snapshot } from './snapshot.js';

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
  'cookies_import',
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
  'goto',
  {
    title: '페이지 이동',
    description: '주소로 이동하고 화면이 다 뜰 때까지 기다립니다.',
    inputSchema: {
      url: z.string().describe('이동할 주소'),
      waitForText: z.string().optional().describe('이 글자가 보일 때까지 기다림'),
      timeoutMs: z.number().optional().describe('최대 대기(기본 30000)'),
    },
  },
  async ({ url, waitForText, timeoutMs }) => {
    const { page } = current();
    const timeout = timeoutMs ?? 30_000;
    await page.goto(assertWebUrl(url), { waitUntil: 'domcontentloaded', timeout });
    // SPA 는 주소만 바뀌고 내용은 나중에 옵니다. 그래서 조용해질 때까지 한 번 더 기다립니다.
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    if (waitForText) {
      await page.getByText(waitForText, { exact: false }).first().waitFor({ timeout }).catch(() => {});
    }
    return text({ url: page.url(), title: await page.title() });
  },
);

server.registerTool(
  'wait',
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
  'snapshot',
  {
    title: '화면 요소 뽑기',
    description:
      '지금 화면에서 사람이 만질 수 있는 요소를 전부 뽑습니다. 각 요소에 ref(e1, e2...)가 붙고, ' +
      'click·type 은 이 ref 로 요소를 집습니다. 좌표는 절대 쓰지 않습니다. ' +
      '선택 상자의 선택지와 표의 머리글도 같이 담습니다.',
    inputSchema: { limit: z.number().optional().describe('최대 개수(기본 400)') },
  },
  async ({ limit }) => {
    const { page } = current();
    return text(await snapshot(page, limit ?? 400));
  },
);

server.registerTool(
  'network_list',
  {
    title: '화면이 부른 JSON 목록',
    description: '창이 열린 뒤 오간 XHR/JSON 응답 목록입니다. 본문은 빼고 목록만 봅니다.',
    inputSchema: { filter: z.string().optional().describe('URL 에 이 글자가 든 것만') },
  },
  async ({ filter }) => {
    const { recorder } = current();
    return text(recorder.list(filter));
  },
);

server.registerTool(
  'network_body',
  {
    title: 'JSON 본문 보기',
    description: 'network_list 에서 고른 ref 하나의 응답 본문 전체를 봅니다.',
    inputSchema: { ref: z.number().describe('network_list 의 ref 번호') },
  },
  async ({ ref }) => {
    const { recorder } = current();
    const e = recorder.get(ref);
    return text(e ?? { error: `ref ${ref} 를 못 찾았습니다.` });
  },
);

server.registerTool(
  'click',
  {
    title: '클릭',
    description: 'ref 로 집은 요소를 사람처럼(곡선 마우스) 클릭합니다.',
    inputSchema: {
      ref: z.string().describe('snapshot 이 준 ref (예: e12)'),
      timeoutMs: z.number().optional(),
    },
  },
  async ({ ref, timeoutMs }) => {
    const { page } = current();
    await byRef(page, ref).click({ timeout: timeoutMs ?? 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    return text({ clicked: ref, url: page.url() });
  },
);

server.registerTool(
  'type',
  {
    title: '입력',
    description:
      'ref 로 집은 칸을 클릭하고 사람처럼 한 글자씩 칩니다. ' +
      'Camoufox 는 마우스만 사람처럼 움직이므로 타이핑 간격은 여기서 줍니다.',
    inputSchema: {
      ref: z.string(),
      value: z.string(),
      delayMs: z.number().optional().describe('글자 사이 간격(기본 60~140 무작위)'),
      clear: z.boolean().optional().describe('기존 값을 지우고 입력(기본 true)'),
      submit: z.boolean().optional().describe('입력 후 Enter'),
    },
  },
  async ({ ref, value, delayMs, clear, submit }) => {
    const { page } = current();
    const el = byRef(page, ref);
    await el.click();
    if (clear !== false) await el.fill('');
    // 사람은 일정한 속도로 치지 않습니다. 그래서 글자마다 간격을 조금씩 흔듭니다.
    for (const ch of value) {
      await el.pressSequentially(ch, { delay: delayMs ?? 60 + Math.floor(Math.random() * 80) });
    }
    if (submit) await el.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    return text({ typed: ref, submitted: !!submit, url: page.url() });
  },
);

server.registerTool(
  'screenshot',
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
  'page_dump',
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
    },
  },
  async ({ menuKey, menuPath, note, netFilter }) => {
    const { page, recorder } = current();
    const snap = await snapshot(page, 400);
    const all = recorder.all();
    const net = netFilter ? all.filter((e) => e.url.includes(netFilter)) : all;
    const files = writeDump({ menuKey, menuPath, note, snap, net });
    return text({
      ...files,
      요소: snap.elements.length,
      API: net.length,
      표: snap.tables.length,
      다음: 'md 파일 맨 아래 "이 화면에서 할 수 있는 일" 표를 사람과 상의해서 채우세요.',
    });
  },
);

server.registerTool(
  'network_clear',
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
