import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Camoufox } from 'camoufox-js';
import type { BrowserContext, Page } from 'playwright-core';
import { NetworkRecorder } from './network.js';

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

export interface OpenOptions {
  /** 프로필 폴더. 로그인 상태가 여기 남습니다. */
  profileDir?: string;
  /** 이미지 차단. 조사할 때는 false 로 두세요(이미지 요소도 봐야 하므로). */
  blockImages?: boolean;
  /** 창 크기 [가로, 세로] */
  window?: [number, number];
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
}> {
  if (context && page && recorder && !page.isClosed()) {
    return { page, context, recorder, reused: true };
  }

  const profileDir = opts.profileDir ?? defaultProfileDir();

  // user_data_dir 을 주면 Camoufox 가 Browser 가 아니라 BrowserContext 를 돌려줍니다.
  // 그래야 로그인 상태(쿠키)가 프로필 폴더에 남습니다.
  context = (await Camoufox({
    user_data_dir: profileDir,
    headless: false, // 사람이 눈으로 봐야 하므로 항상 창을 띄웁니다.
    humanize: true, // 사람처럼 곡선을 그리는 마우스 (Camoufox 내장, 커서 전용)
    os: 'windows',
    block_images: opts.blockImages ?? false,
    enable_cache: true,
    geoip: false, // 프록시를 켤 때만 true 로 바꾸세요.
    window: opts.window ?? [1600, 1000],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    // locale 은 일부러 지정하지 않습니다.
    // 실제 IP 와 언어가 어긋나면 그게 오히려 눈에 띄는 신호가 됩니다.
  })) as unknown as BrowserContext;

  recorder = new NetworkRecorder();
  recorder.attach(context);

  page = context.pages()[0] ?? (await context.newPage());
  openedAt = Date.now();

  return { page, context, recorder, reused: false };
}

export function current(): { page: Page; context: BrowserContext; recorder: NetworkRecorder } {
  if (!context || !page || !recorder || page.isClosed()) {
    throw new Error('브라우저가 아직 안 열렸습니다. 먼저 browser_open 을 부르세요.');
  }
  return { page, context, recorder };
}

export async function closeBrowser(): Promise<boolean> {
  if (!context) return false;
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
  };
}
