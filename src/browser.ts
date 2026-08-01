import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Camoufox } from 'camoufox-js';
import type { BrowserContext, Page } from 'playwright-core';
import { NetworkRecorder } from './network.js';
import { watchPopupWindows } from './popup.js';
import { pickWindowSize, viewportFor } from './screen.js';
import { restoreSession, saveSession } from './session.js';

// Node 21 에서는 camoufox-js 의 지문 생성 단계에서 프로세스가 통째로 죽습니다
// (Windows 접근 위반, 오류 메시지도 안 남음). Node 22 LTS 이상에서만 씁니다.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  throw new Error(
    `Node ${process.versions.node} 은(는) 지원하지 않습니다. Node 22 이상이 필요합니다.\n` +
      `Node 21 에서는 브라우저를 띄우다가 프로세스가 조용히 죽습니다.\n` +
      `해결: nvm install 22 && nvm use 22 (Windows 는 PATH 에 v21 경로가 박혀 있으면 먼저 지우세요)`,
  );
}

/** 브라우저 하나만 띄웁니다. 리소스를 아끼려고 창을 여러 개 만들지 않습니다. */
let context: BrowserContext | null = null;
let page: Page | null = null;
let recorder: NetworkRecorder | null = null;
let openedAt = 0;
let lastSize: { width: number; height: number; source: string } | null = null;
let currentProfile = '';
/** 마지막으로 로그인 복원을 시도한 결과. 왜 로그아웃됐는지 바로 알 수 있게 남깁니다. */
let lastSession: { restored: number; skipped: number; ageHours: number | null } | null = null;

export interface OpenOptions {
  /** 프로필 폴더. 로그인 상태가 여기 남습니다. */
  profileDir?: string;
  /** 이미지 차단. 조사할 때는 false 로 두세요(이미지 요소도 봐야 하므로). */
  blockImages?: boolean;
  /** 창 크기 [가로, 세로]. 안 주면 모니터 크기에 맞춥니다. */
  window?: [number, number];
  /** 화면 없이 돌리기. 기본은 false — 사람이 같이 봐야 하므로 창을 띄웁니다. */
  headless?: boolean;
  /** 프록시 (예: http://user:pass@host:port). 세션이 끊기므로 회전형은 쓰지 마세요. */
  proxy?: string;
}

/** 지금 켜져 있는 브라우저 이름을 알려줍니다. 어느 브라우저를 피할지 판단하는 데 씁니다. */
export function runningBrowsers(): string[] {
  const names = ['chrome', 'firefox', 'msedge'];
  const found: string[] = [];
  for (const n of names) {
    try {
      // tasklist 는 못 찾으면 "INFO: No tasks..." 를 stdout 으로 냅니다(종료코드 0).
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${n}.exe`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (out.toLowerCase().includes(`${n}.exe`)) found.push(n);
    } catch {
      // Windows 가 아니거나 tasklist 가 없으면 그냥 넘어갑니다.
    }
  }
  return found;
}

export function defaultProfileDir(): string {
  return process.env.CAMOUFOX_MCP_PROFILE ?? path.resolve(process.cwd(), '.profile', 'default');
}

export async function openBrowser(opts: OpenOptions = {}): Promise<{
  page: Page;
  context: BrowserContext;
  recorder: NetworkRecorder;
  reused: boolean;
  restoredCookies: number;
}> {
  if (context && page && recorder && !page.isClosed()) {
    return { page, context, recorder, reused: true, restoredCookies: 0 };
  }

  const profileDir = opts.profileDir ?? defaultProfileDir();
  const headless = opts.headless ?? false; // 기본은 창을 띄웁니다.

  // 창 크기: 헤드풀이면 모니터 작업 영역에 꽉 차게, 헤드리스면 평범한 크기.
  const size = opts.window
    ? { width: opts.window[0], height: opts.window[1], source: '직접 지정' }
    : pickWindowSize(headless);
  const viewport = viewportFor(size);
  lastSize = size;

  // user_data_dir 을 주면 Camoufox 가 Browser 가 아니라 BrowserContext 를 돌려줍니다.
  // 그래야 로그인 상태(쿠키)가 프로필 폴더에 남습니다.
  context = (await Camoufox({
    user_data_dir: profileDir,
    headless,
    // 사람처럼 곡선을 그리는 마우스 (Camoufox 내장, 커서 전용).
    //
    // **숫자로 상한을 줘야 합니다.** `true` 는 상한이 없어서, 2560px 짜리 넓은 창에서는
    // 마우스가 화면을 한 번 가로지르는 데 **57초**가 걸렸습니다(2026-08-01 실측).
    // 그러면 Playwright 의 클릭이 시간초과로 죽고, 좌표로 찍는 마지막 수단으로 떨어집니다.
    // 좌표 클릭은 스크롤이 어긋나면 빗나가는데, **빗나가도 "눌렀다"고 답합니다.**
    // 오늘 연령 체크박스가 안 눌린 진짜 원인이 이것이었습니다.
    // 0.7초면 사람이 마우스를 휙 옮기는 속도와 비슷하고, 곡선도 그대로 그립니다.
    humanize: 0.7,
    os: 'windows',
    block_images: opts.blockImages ?? false,
    enable_cache: true,
    geoip: false, // 프록시를 켤 때만 true 로 바꾸세요.
    // window 는 지문에, viewport 는 실제 창 크기에 반영됩니다. 둘을 맞춰야 어긋나지 않습니다.
    window: [size.width, size.height],
    viewport,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    // locale 은 일부러 지정하지 않습니다.
    // 실제 IP 와 언어가 어긋나면 그게 오히려 눈에 띄는 신호가 됩니다.
  })) as unknown as BrowserContext;

  recorder = new NetworkRecorder();
  recorder.attach(context);

  // 별도 창으로 뜨는 팝업은 열리는 즉시 처리합니다.
  watchPopupWindows(context, (m) => process.stderr.write(`[popup] ${m}\n`));

  // 지난번 로그인 상태를 되돌립니다. 네이버 세션 쿠키는 프로필에 안 남기 때문입니다.
  const sess = await restoreSession(context, profileDir);
  lastSession = sess;
  if (sess.restored || sess.skipped) {
    process.stderr.write(
      `[session] 복원 ${sess.restored}개 / 만료로 버림 ${sess.skipped}개` +
        (sess.ageHours !== null ? ` / 저장된 지 ${sess.ageHours.toFixed(1)}시간` : '') +
        '\n',
    );
  }
  // 네이버 로그인은 창을 닫으면 사라지는 세션 쿠키를 씁니다.
  // 몇 시간이 지나면 서버 쪽에서도 끊기므로, 저장해둔 쿠키만으로는 되살릴 수 없습니다.
  // 로그인할 때 "로그인 상태 유지"를 켜야 오래 가는 쿠키가 발급됩니다.
  if (sess.ageHours !== null && sess.ageHours > 6) {
    process.stderr.write(
      `[session] 저장한 지 ${sess.ageHours.toFixed(0)}시간 지났습니다. 다시 로그인해야 할 수 있습니다.\n`,
    );
  }

  page = context.pages()[0] ?? (await context.newPage());
  openedAt = Date.now();
  currentProfile = profileDir;

  // 마우스 예열. **빼면 안 됩니다.**
  //
  // 실측(2026-08-01): 창을 연 뒤 **맨 처음 마우스를 쓰는 한 번**이 20~57초 걸립니다.
  // 그동안 Playwright 의 클릭은 시간초과로 죽고, 좌표로 찍는 마지막 수단으로 떨어집니다.
  // 좌표 클릭은 빗나가도 "눌렀다"고 답하기 때문에, 고치지도 않고 고쳤다고 보고하게 됩니다.
  // 여기서 미리 한 번 눌러 그 비용을 치르면 이후 클릭은 1초 남짓으로 안정됩니다(5번 연속 성공).
  {
    const t0 = Date.now();
    await page.mouse.move(300, 300).catch(() => {});
    await page.mouse.down().catch(() => {});
    await page.mouse.up().catch(() => {});
    process.stderr.write(`[mouse] 예열 ${((Date.now() - t0) / 1000).toFixed(1)}초 (첫 클릭이 죽는 것을 막습니다)\n`);
  }

  return { page, context, recorder, reused: false, restoredCookies: sess.restored };
}

export function current(): { page: Page; context: BrowserContext; recorder: NetworkRecorder } {
  if (!context || !recorder) {
    throw new Error('브라우저가 아직 안 열렸습니다. 먼저 browser_open 을 부르세요.');
  }
  // 보던 탭이 닫혔으면 남아 있는 탭으로 옮깁니다. 그래야 "브라우저가 죽었다"고 오해하지 않습니다.
  if (!page || page.isClosed()) {
    const alive = context.pages().filter((p) => !p.isClosed());
    if (!alive.length) throw new Error('열린 탭이 없습니다. browser_open 을 다시 부르세요.');
    page = alive[alive.length - 1];
  }
  return { page, context, recorder };
}

/** 열려 있는 탭 목록. 새 창으로 열리는 메뉴를 다룰 때 씁니다. */
export function listPages(): Array<{ index: number; url: string; active: boolean }> {
  if (!context) return [];
  return context.pages().map((p, i) => ({
    index: i,
    url: p.isClosed() ? '(닫힘)' : p.url(),
    active: p === page,
  }));
}

/** 볼 탭을 바꿉니다. index 를 안 주면 가장 최근에 열린 탭으로 갑니다. */
export function usePage(index?: number): { index: number; url: string } {
  if (!context) throw new Error('브라우저가 아직 안 열렸습니다.');
  const pages = context.pages().filter((p) => !p.isClosed());
  if (!pages.length) throw new Error('열린 탭이 없습니다.');
  const target = index === undefined ? pages[pages.length - 1] : pages[index];
  if (!target) throw new Error(`${index} 번 탭이 없습니다. 지금 ${pages.length}개 열려 있습니다.`);
  page = target;
  return { index: context.pages().indexOf(target), url: target.url() };
}

/** 탭 하나를 닫습니다. 광고 창을 치울 때 씁니다. */
export async function closePage(index: number): Promise<boolean> {
  if (!context) return false;
  const target = context.pages()[index];
  if (!target || target.isClosed()) return false;
  await target.close().catch(() => {});
  return true;
}

/** 지금 로그인 상태를 파일로 저장합니다. 창을 닫아도 다음에 그대로 이어집니다. */
export async function saveNow(): Promise<number> {
  if (!context) return 0;
  return saveSession(context, currentProfile || defaultProfileDir()).catch(() => 0);
}

export async function closeBrowser(): Promise<boolean> {
  if (!context) return false;
  // 닫기 전에 반드시 저장합니다. 안 하면 로그인이 사라집니다.
  await saveNow();
  await context.close().catch(() => {});
  context = null;
  page = null;
  recorder = null;
  return true;
}

export function status() {
  return {
    open: !!context && !!page && !page.isClosed(),
    url: page && !page.isClosed() ? page.url() : null,
    openedForSeconds: openedAt ? Math.round((Date.now() - openedAt) / 1000) : 0,
    runningBrowsers: runningBrowsers(),
    profileDir: defaultProfileDir(),
    windowSize: lastSize,
    session: lastSession,
  };
}
