import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';

/**
 * 로그인 상태를 파일로 남겼다가 다시 넣습니다.
 *
 * 왜 필요한가: 네이버 커머스 로그인은 "로그인 상태 유지"를 켜지 않으면
 * 브라우저를 닫는 순간 사라지는 세션 쿠키를 씁니다. 프로필 폴더에 안 남습니다.
 * 그래서 닫기 전에 따로 저장해 두었다가 다음에 켤 때 넣어줍니다.
 */
function sessionFile(profileDir: string): string {
  return path.join(path.dirname(profileDir), `${path.basename(profileDir)}.session.json`);
}

export async function saveSession(context: BrowserContext, profileDir: string): Promise<number> {
  const state = await context.storageState();
  const file = sessionFile(profileDir);
  // 이 파일에는 로그인 쿠키가 그대로 들어갑니다. 남이 읽으면 계정을 그대로 쓸 수 있습니다.
  // 그래서 주인만 읽고 쓰게 막습니다. (리눅스·맥에서 적용됩니다. 윈도우는 NTFS 권한을 따릅니다.)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state));
  } finally {
    fs.closeSync(fd);
  }
  return state.cookies.length;
}

export async function restoreSession(
  context: BrowserContext,
  profileDir: string,
): Promise<{ restored: number; skipped: number; ageHours: number | null; from: string | null }> {
  const file = sessionFile(profileDir);
  const none = { restored: 0, skipped: 0, ageHours: null, from: null };
  if (!fs.existsSync(file)) return none;
  try {
    const ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      cookies?: Parameters<BrowserContext['addCookies']>[0];
    };
    const all = state.cookies ?? [];
    // 이미 지난 쿠키는 넣어봐야 소용없습니다. 넣으면 오히려 왜 안 되는지 헷갈립니다.
    const now = Date.now() / 1000;
    const fresh = all.filter((c) => !c.expires || c.expires === -1 || c.expires > now);
    if (!fresh.length) return { ...none, skipped: all.length, ageHours, from: file };
    await context.addCookies(fresh);
    return { restored: fresh.length, skipped: all.length - fresh.length, ageHours, from: file };
  } catch {
    return { ...none, from: file };
  }
}

/** 이 파일에는 로그인 정보가 들어 있습니다. 절대 커밋하면 안 됩니다(.gitignore 에 있음). */
export function sessionPath(profileDir: string): string {
  return sessionFile(profileDir);
}
