import type { BrowserContext, Page } from 'playwright-core';

/**
 * 알림창 정리.
 *
 * 실측(2026-07-27, 스마트스토어센터 대시보드):
 *  - 체크박스는 `input[name="again"]` 이고 **pointer-events: none** 이라 직접 못 누릅니다.
 *    라벨(`label.text-sub`)이 그 위를 덮고 있어서, 라벨을 눌러야 체크됩니다.
 *  - 네이버 공지 패널은 체크하는 순간 같이 닫힙니다. 그래서 닫기 버튼은 "남아 있을 때만" 누릅니다.
 *  - 닫기 버튼: `button.close`(헤더 X) 또는 `button.btn-default2`(아래 "닫기").
 */
const DONT_SHOW_INPUT = 'input[name="again"], input[name="todayClose"], input[name="notToday"]';

/** 팝업 상자. 안쪽 작은 상자를 팝업으로 착각하지 않으려고 명시합니다. */
const BOX = '[role="dialog"], .modal-content, .layer_popup, .seller-layer-modal';

/**
 * 닫기 버튼.
 *
 * 실측(2026-07-28, "통신판매업 신고 안내" 팝업): 이 팝업의 닫기 버튼은
 * `button.close` 도 `button.btn-default2` 도 아니었습니다. 클래스 없는 그냥 `button` 에
 * 글자만 "닫기"/"Close" 였습니다. 그래서 **글자로 찾는 방법을 반드시 같이 둡니다.**
 * 클래스는 배포할 때마다 바뀌지만 글자는 잘 안 바뀝니다.
 *
 * ⚠️ **"확인" 은 여기에 넣지 않습니다.** 닫기가 아니라 **실행**인 경우가 있습니다.
 *    ("이 주문을 발송처리하시겠습니까? [확인]") 되돌릴 수 없는 일이 승인 없이 벌어집니다.
 *    "확인" 만 있는 알림창은 못 닫은 것으로 두고 사람에게 넘깁니다(`remaining`).
 */
const CLOSE = [
  'button.close',
  'button.btn-default2',
  '[aria-label="닫기"]',
  '[aria-label="Close"]',
  'button:text-is("닫기")',
  'button:text-is("Close")',
  'a:text-is("닫기")',
].join(', ');

/** 절대 누르면 안 되는 것. 팝업 안에 있어도 이건 실제 업무를 실행합니다. */
const NEVER = /입력하기|신청|등록|삭제|저장|동의|결제|발송|승인|제출|이동하기|구매|주문/;

export interface PopupAction {
  title: string;
  checkedDontShow: boolean;
  closed: boolean;
  how: string;
}

export interface PopupReport {
  found: number;
  actions: PopupAction[];
  /** 못 닫은 것. 사람이 봐야 합니다. */
  remaining: string[];
}

export interface PopupOptions {
  /** 체크박스 선택자. 안 주면 실측 기본값. */
  dontShowSelector?: string;
  /** 닫기 버튼 선택자. */
  closeSelector?: string;
  /** 팝업 상자 선택자. */
  boxSelector?: string;
}

async function firstVisible(page: Page, selector: string) {
  const loc = page.locator(selector);
  const n = await loc.count();
  for (let i = 0; i < Math.min(n, 10); i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

export async function closeLayerPopups(page: Page, opt: PopupOptions = {}): Promise<PopupReport> {
  const inputSel = opt.dontShowSelector ?? DONT_SHOW_INPUT;
  const boxSel = opt.boxSelector ?? BOX;
  const closeSel = opt.closeSelector ?? CLOSE;
  const report: PopupReport = { found: 0, actions: [], remaining: [] };

  for (let round = 0; round < 6; round++) {
    // 체크박스를 감싼 라벨을 찾습니다. 체크박스 자체는 클릭을 안 받습니다.
    const label = await firstVisible(page, `label:has(${inputSel})`);
    const box = label ? null : await firstVisible(page, boxSel);
    if (!label && !box) break;

    report.found++;
    const action: PopupAction = { title: '', checkedDontShow: false, closed: false, how: '' };

    // 제목은 팝업 상자에서 읽습니다. 없으면 라벨 기준 상위 상자에서.
    const boxLoc = label ? page.locator(boxSel).filter({ has: page.locator(inputSel) }).first() : box!;
    action.title =
      (await boxLoc
        .locator('.modal-title, h1, h2, h3, strong')
        .first()
        .innerText({ timeout: 2_000 })
        .catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '(제목 없음)';

    // ① "하루 동안 보지 않기" — 라벨을 누릅니다.
    if (label) {
      await label.click({ timeout: 5_000 }).catch((e) => {
        action.how += `라벨 클릭 실패(${String(e).split('\n')[0]}). `;
      });
      action.checkedDontShow = await page
        .locator(inputSel)
        .first()
        .isChecked()
        .catch(() => false);
      // 체크하는 순간 팝업이 같이 닫히는 경우가 있어, 사라졌으면 체크된 것으로 봅니다.
      const gone = !(await boxLoc.isVisible().catch(() => false));
      if (gone) action.checkedDontShow = true;
      action.how += action.checkedDontShow ? '"하루 동안 보지 않기" 처리됨. ' : '체크 확인 안 됨. ';
    } else {
      action.how += '체크박스 없음. ';
    }

    // ② 아직 남아 있으면 닫기. (체크만으로 닫히는 팝업이 있어 먼저 확인합니다.)
    if (await boxLoc.isVisible().catch(() => false)) {
      const closer = await firstVisible(page, `${boxSel} :is(${closeSel})`);
      if (closer) {
        const t = (await closer.innerText().catch(() => '')).trim();
        if (NEVER.test(t)) {
          action.how += `닫기 후보가 위험한 버튼("${t}")이라 안 눌렀습니다. `;
        } else {
          await closer.click({ timeout: 5_000 }).catch((e) => {
            action.how += `닫기 클릭 실패(${String(e).split('\n')[0]}). `;
          });
          action.how += `닫기 클릭("${t || 'X'}"). `;
        }
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        action.how += '닫기 버튼을 못 찾아 Esc. ';
      }
    }

    // ③ 진짜 사라졌는지 확인 — 이게 없으면 "닫았다"고 착각합니다.
    await page.waitForTimeout(500);
    action.closed = !(await boxLoc.isVisible().catch(() => false));
    action.how += action.closed ? '사라진 것 확인.' : '아직 남아 있음.';
    report.actions.push(action);

    if (!action.closed) {
      report.remaining.push(action.title);
      break; // 못 닫는 것을 반복하면 무한루프가 됩니다.
    }
  }

  return report;
}

/** 별도 창(window.open)으로 뜨는 팝업은 열리는 즉시 닫습니다. */
/**
 * 새로 열리는 창을 지켜봅니다.
 *
 * 예전에는 새 창을 무조건 닫았습니다. 그런데 "사진 보관함"처럼 **진짜 기능이 새 창으로 열리는**
 * 메뉴가 있어서, 눌러도 아무 일도 안 일어나는 것처럼 보였습니다.
 * 그래서 이제 **닫지 않고 알리기만** 합니다. 닫을지 말지는 부르는 쪽이 정합니다.
 * 새 창 안의 겹쳐진 알림창만 정리해 둡니다.
 */
export function watchPopupWindows(context: BrowserContext, log: (m: string) => void): void {
  context.on('page', async (p: Page) => {
    try {
      await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      await closeLayerPopups(p).catch(() => null);
      log(`새 창이 열렸습니다: ${p.url()}`);
    } catch {
      // 이미 닫혔으면 무시합니다.
    }
  });
}
