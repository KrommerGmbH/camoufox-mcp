import http from 'node:http';
import { closeBrowser, closePage, current, goTo, listPages, openBrowser, saveNow, status, usePage } from './browser.js';
import { outDir, writeDump } from './dump.js';
import { extractFromHtml } from './extract.js';
import { assertWebUrl } from './guard.js';
import { closeLayerPopups } from './popup.js';
import { contentTarget, snapshotBoth, targetForRef } from './frame.js';
import { byRef, snapshot } from './snapshot.js';

/**
 * 로컬 전용 조종 서버.
 *
 * MCP 로 붙기 어려운 상황(에디터를 다시 못 켤 때)에도 브라우저를 계속 열어둔 채
 * 명령만 보내서 조사를 이어갈 수 있게 합니다. MCP 와 같은 기능을 HTTP 로 낼 뿐입니다.
 *
 * 실행: node dist/serve.js [포트]
 * 사용: curl -s localhost:8787/call -d '{"op":"goto","url":"https://..."}'
 *
 * ⚠️ 127.0.0.1 에만 붙습니다. 이 컴퓨터 밖에서는 접근할 수 없습니다.
 */
const PORT = Number(process.argv[2] ?? process.env.CAMOUFOX_HTTP_PORT ?? 8787);

type Args = Record<string, any>;

const ops: Record<string, (a: Args) => Promise<unknown>> = {
  async open(a) {
    const r = await openBrowser({
      blockImages: a.blockImages,
      headless: a.headless,
      proxy: a.proxy,
      window: a.window,
    });
    return { reused: r.reused, ...status() };
  },

  async status() {
    return status();
  },

  async close() {
    return { closed: await closeBrowser() };
  },

  /** 로그인 직후에 부르세요. 창을 안 닫아도 로그인 상태가 파일에 저장됩니다. */
  async save() {
    return { savedCookies: await saveNow() };
  },

  async goto(a) {
    const { page } = current();
    const timeout = a.timeoutMs ?? 45_000;
    // `#` 뒤만 바뀌는 주소는 `page.goto` 로 가면 화면이 안 바뀝니다(앞 화면이 그대로 남습니다).
    // 그래서 여기서도 `goTo` 를 씁니다. `browser_navigate`·로그인·조사 스크립트와 같은 길입니다.
    await goTo(page, assertWebUrl(a.url), timeout);
    if (a.waitForText) {
      await page.getByText(a.waitForText, { exact: false }).first().waitFor({ timeout }).catch(() => {});
    }
    // 새 주소로 갈 때마다 알림창을 정리합니다. 끄려면 closePopups:false.
    const popups = a.closePopups === false ? null : await closeLayerPopups(page);
    return { url: page.url(), title: await page.title(), popups };
  },

  async popups(a) {
    const { page } = current();
    return closeLayerPopups(page, {
      dontShowSelector: a.dontShowSelector,
      closeSelector: a.closeSelector,
      boxSelector: a.boxSelector,
    });
  },

  /** 선택자로 바로 클릭. 진단용 + 정확한 선택자를 이미 아는 경우용. */
  async clickSel(a) {
    const { page } = current();
    const loc = page.locator(a.selector);
    const count = await loc.count();
    const visible = count ? await loc.first().isVisible().catch(() => false) : false;
    let clicked = false;
    let error = '';
    try {
      await loc.first().click({ timeout: a.timeoutMs ?? 8_000, force: !!a.force });
      clicked = true;
    } catch (e) {
      error = String(e).split('\n').slice(0, 3).join(' ');
    }
    await page.waitForTimeout(400);
    return { selector: a.selector, count, visible, clicked, error, url: page.url() };
  },

  /** 요소가 어떤 상태인지 봅니다. 왜 클릭이 안 되는지 진단할 때 씁니다. */
  async probe(a) {
    const { page } = current();
    return page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel)).slice(0, 5);
      return els.map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        // 그 자리에 실제로 무엇이 있는지 — 다른 것이 덮고 있으면 클릭이 안 됩니다.
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          tag: el.tagName.toLowerCase(),
          text: ((el as HTMLElement).innerText ?? '').trim().slice(0, 30),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          display: s.display,
          visibility: s.visibility,
          opacity: s.opacity,
          pointerEvents: s.pointerEvents,
          zIndex: s.zIndex,
          checked: (el as HTMLInputElement).checked ?? null,
          coveredBy:
            top && top !== el && !el.contains(top)
              ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().split(' ')[0]}`
              : null,
        };
      });
    }, a.selector);
  },

  async wait(a) {
    const { page } = current();
    if (a.forText) {
      await page.getByText(a.forText, { exact: false }).first().waitFor({ timeout: a.timeoutMs ?? 30_000 });
    }
    if (a.ms) await page.waitForTimeout(a.ms);
    return { url: page.url() };
  },

  async snapshot(a) {
    const { page } = current();
    // 내용이 iframe 안에 있으면 그 안쪽을 봅니다(판매관리·정산관리가 그렇습니다).
    return snapshotBoth(page, { limit: a.limit ?? 400, find: a.find, only: a.only, verbose: a.verbose }, snapshot);
  },

  async netlist(a) {
    const { recorder } = current();
    return recorder.list(a.filter);
  },

  async netbody(a) {
    const { recorder } = current();
    return recorder.get(Number(a.ref)) ?? { error: `ref ${a.ref} 없음` };
  },

  async netclear() {
    current().recorder.clear();
    return { cleared: true };
  },

  async click(a) {
    const { page } = current();
    const el = byRef(await targetForRef(page, a.ref), a.ref);
    let how = '보통';
    try {
      await el.click({ timeout: a.timeoutMs ?? 15_000, force: !!a.force });
    } catch (e) {
      // 네이버 관리자는 Angular 가 화면을 계속 다시 그려서, Playwright 의
      // "요소가 멈출 때까지 기다리기"가 영영 안 끝나는 곳이 있습니다.
      // 이럴 때만 기다림을 건너뜁니다.
      //
      // ⚠️ 건너뛰면 "화면 안으로 스크롤" 도 같이 건너뜁니다.
      // 화면 밖에 있는 요소를 그냥 누르면 그 좌표에 있는 **다른 것**이 눌립니다.
      // (왼쪽 메뉴 13번째 항목을 누르려다 엉뚱한 걸 눌러 메뉴가 접힌 적이 있습니다.)
      // 그래서 먼저 화면 안으로 끌어온 뒤에 누릅니다.
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      const box = await el.boundingBox().catch(() => null);
      if (!box) throw e;
      // 요소를 집어서 누르는 대신 **좌표로 진짜 마우스를 움직여서** 누릅니다.
      // Playwright 의 안전장치(요소가 멈출 때까지 기다리기)를 아예 안 거치므로 안 걸립니다.
      // 가짜 이벤트가 아니라 실제 마우스 이동+클릭이라 사람처럼 보이는 것도 그대로입니다.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      how = '좌표 클릭(스크롤 후)';
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const popups = a.closePopups === false ? null : await closeLayerPopups(page);
    return { clicked: a.ref, how, url: page.url(), popups };
  },

  async type(a) {
    const { page } = current();
    const el = byRef(await targetForRef(page, a.ref), a.ref);
    await el.click();
    if (a.clear !== false) await el.fill('');
    for (const ch of String(a.value)) {
      await el.pressSequentially(ch, { delay: a.delayMs ?? 60 + Math.floor(Math.random() * 80) });
    }
    if (a.submit) await el.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    return { typed: a.ref, url: page.url() };
  },

  async screenshot(a) {
    const { page } = current();
    const buf = await page.screenshot({ fullPage: !!a.fullPage, type: 'png' });
    return { base64: buf.toString('base64'), bytes: buf.length };
  },

  async dump(a) {
    const { page, recorder } = current();
    // 화면 요소는 전부 담습니다. 잘리면 나중에 다시 조사해야 합니다.
    const snap = await snapshotBoth(page, { limit: a.limit ?? 1500, verbose: true }, snapshot);
    // 화면 구조 요약은 Playwright 가 직접 만들어 줍니다. 새 라이브러리가 필요 없습니다.
    const aria = await page
      .locator('body')
      .ariaSnapshot()
      .catch(() => undefined);
    // 다 그려진 HTML 을 cheerio 로 훑습니다.
    // 스냅샷이 못 보는 것(글 내용, select 선택지 전부, 표 머리글)을 여기서 채웁니다.
    const inner = await contentTarget(page);
    const extract = extractFromHtml(await inner.target.content(), page.url());
    const all = recorder.all();
    const net = a.netFilter ? all.filter((e) => e.url.includes(a.netFilter)) : all;
    const files = writeDump({
      menuKey: a.menuKey,
      menuPath: a.menuPath,
      note: a.note,
      snap,
      net,
      aria,
      extract,
      maskPii: a.maskPii !== false && /naverpay|order|claim|talktalk|inquiry|customer|review/i.test(page.url()),
    });
    return {
      ...files,
      elements: snap.elements.length,
      fields: extract.fields.length,
      selects: extract.fields.filter((f) => f.options?.length).length,
      apis: net.length,
      tables: extract.tables.length,
      content: extract.stats.dropRatio,
      inFrame: snap.inFrame,
      바깥요소: snap.outerCount,
      프레임요소: snap.frameCount,
    };
  },

  async pages() {
    return { pages: listPages() };
  },

  async usePage(a) {
    return usePage(a.index);
  },

  async closePage(a) {
    return { closed: await closePage(a.index) };
  },

  async extract(a) {
    const { page } = current();
    const r = extractFromHtml(await (await contentTarget(page)).target.content(), page.url());
    if (a.what === 'content') return { markdown: r.markdown };
    if (a.what === 'fields') return { fields: r.fields };
    if (a.what === 'tables') return { tables: r.tables };
    if (a.what === 'links') return { links: r.links };
    return r;
  },
};

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/call') {
    res.writeHead(404).end('POST /call 만 받습니다');
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', async () => {
    let out: unknown;
    let code = 200;
    try {
      const a = JSON.parse(body || '{}') as Args;
      const fn = ops[a.op];
      if (!fn) throw new Error(`모르는 명령: ${a.op}. 가능: ${Object.keys(ops).join(', ')}`);
      out = await fn(a);
    } catch (e) {
      code = 400;
      out = { error: e instanceof Error ? e.message : String(e) };
    }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`조종 서버: http://127.0.0.1:${PORT}/call`);
  console.log(`결과 저장 위치: ${outDir()}`);
  console.log(`명령: ${Object.keys(ops).join(', ')}`);
});
