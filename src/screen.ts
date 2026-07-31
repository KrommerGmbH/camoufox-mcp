import { execFileSync } from 'node:child_process';

export interface ScreenSize {
  width: number;
  height: number;
  source: string;
}

/** 헤드리스일 때 쓰는 평범한 크기. 너무 크면 오히려 눈에 띕니다. */
const HEADLESS_SIZE: ScreenSize = { width: 1280, height: 800, source: 'headless-기본값' };

/** 화면 크기를 못 읽었을 때 쓰는 값. */
const FALLBACK: ScreenSize = { width: 1600, height: 1000, source: '폴백' };

/**
 * 주 모니터의 실제 작업 영역 크기를 읽습니다.
 * 작업 영역 = 전체 화면에서 작업 표시줄을 뺀 크기입니다.
 */
function primaryWorkArea(): ScreenSize | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; ' +
          '$s=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
          'Write-Output "$($s.Width)x$($s.Height)"',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    const m = out.trim().match(/(\d+)x(\d+)/);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]), source: '주 모니터 작업 영역' };
  } catch {
    return null;
  }
}

/**
 * 창을 얼마나 크게 띄울지 정합니다.
 * - 헤드풀: 모니터 작업 영역에 꽉 차게 (사람이 같이 보려면 커야 합니다)
 * - 헤드리스: 평범한 크기
 */
export function pickWindowSize(headless: boolean): ScreenSize {
  if (headless) return HEADLESS_SIZE;
  return primaryWorkArea() ?? FALLBACK;
}

/**
 * 브라우저 껍데기(주소창·탭 줄)가 차지하는 높이를 뺀 화면 안쪽 크기.
 * 이 값을 viewport 로 주면 창이 모니터에 거의 꽉 찹니다.
 */
export function viewportFor(size: ScreenSize): { width: number; height: number } {
  return { width: size.width, height: Math.max(400, size.height - 110) };
}
