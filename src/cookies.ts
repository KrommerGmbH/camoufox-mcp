import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BrowserContext } from 'playwright-core';

export interface ImportResult {
  source: string;
  profile?: string;
  imported: number;
  skipped: number;
  note?: string;
}

type PwCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

/** 파이어폭스 프로필 폴더를 찾습니다. 가장 최근에 쓴 것을 고릅니다. */
function findFirefoxProfile(): string | null {
  const root = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((p) => fs.existsSync(path.join(p, 'cookies.sqlite')))
    .sort(
      (a, b) =>
        fs.statSync(path.join(b, 'cookies.sqlite')).mtimeMs -
        fs.statSync(path.join(a, 'cookies.sqlite')).mtimeMs,
    );
  return candidates[0] ?? null;
}

/**
 * 파이어폭스 쿠키를 복사해 옵니다.
 * 파이어폭스가 켜져 있어도 됩니다 — 파일을 임시 폴더로 복사한 뒤 읽기 때문입니다.
 * 파이어폭스 쿠키는 암호가 안 걸려 있어서 그대로 읽힙니다.
 */
export async function importFirefoxCookies(
  context: BrowserContext,
  domainFilter?: string,
): Promise<ImportResult> {
  const profile = findFirefoxProfile();
  if (!profile) {
    return { source: 'firefox', imported: 0, skipped: 0, note: '파이어폭스 프로필을 못 찾았습니다.' };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-cookies-'));
  try {
    // 파이어폭스가 쓰는 중이면 -wal 파일에 최신 내용이 있습니다. 같이 복사해야 최신 쿠키가 나옵니다.
    for (const suffix of ['', '-wal', '-shm']) {
      const src = path.join(profile, `cookies.sqlite${suffix}`);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, `cookies.sqlite${suffix}`));
    }

    const db = new Database(path.join(tmp, 'cookies.sqlite'), { readonly: true });
    const rows = db
      .prepare(
        `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
           FROM moz_cookies` + (domainFilter ? ` WHERE host LIKE @like` : ''),
      )
      .all(domainFilter ? { like: `%${domainFilter}%` } : {}) as Array<Record<string, unknown>>;
    db.close();

    const cookies: PwCookie[] = [];
    let skipped = 0;
    for (const r of rows) {
      const name = String(r.name ?? '');
      const domain = String(r.host ?? '');
      if (!name || !domain) {
        skipped++;
        continue;
      }
      cookies.push({
        name,
        value: String(r.value ?? ''),
        domain,
        path: String(r.path ?? '/'),
        // 파이어폭스는 초 단위, 0 이면 브라우저 닫을 때까지만 사는 쿠키입니다.
        expires: Number(r.expiry) > 0 ? Number(r.expiry) : -1,
        httpOnly: Number(r.isHttpOnly) === 1,
        secure: Number(r.isSecure) === 1,
        sameSite: (['None', 'Lax', 'Strict'] as const)[Number(r.sameSite) ?? 1] ?? 'Lax',
      });
    }

    if (cookies.length) await context.addCookies(cookies);
    return { source: 'firefox', profile: path.basename(profile), imported: cookies.length, skipped };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 크롬 쿠키는 아직 지원하지 않습니다.
 * 최근 크롬은 App-Bound 암호화라서 크롬 자신이 아니면 값을 못 풉니다.
 * 그래서 창을 띄워 한 번 직접 로그인하는 쪽이 확실합니다.
 */
export async function importChromeCookies(): Promise<ImportResult> {
  return {
    source: 'chrome',
    imported: 0,
    skipped: 0,
    note:
      '크롬 쿠키 복사는 아직 지원하지 않습니다. 최근 크롬은 App-Bound 암호화라 밖에서 값을 못 풉니다. ' +
      '열린 창에서 한 번 직접 로그인하시면 프로필에 그대로 남습니다.',
  };
}
