import type { Page } from 'playwright-core';
import { findBoth } from './frame.js';
import { shopware } from './login.js';

/**
 * 로그인 말고 **화면이 따로 묻는 비밀번호**를 대신 쳐 줍니다.
 * 지금 쓰는 곳: 네이버 주문 엑셀을 받을 때 묻는 비밀번호.
 *
 * **AI 는 이 비밀번호를 못 봅니다. 이것이 이 파일이 있는 이유의 전부입니다.**
 * 값은 샵웨어 서버가 자물쇠를 풀어서 **이 Node 프로세스로만** 보내고, 여기서 바로 화면에 칩니다.
 * 모델(AI)에게 돌아가는 것은 **쳤다/못 쳤다와 이유뿐**입니다 —
 * 값도, 값의 길이도, 값의 일부도 나가지 않습니다.
 *
 * `login.ts` 와 같은 길입니다. 다른 점은 로그인 창이 아니라 **아무 화면의 아무 칸**이라는 것뿐입니다.
 *
 * **어느 칸에 칠지도 코드에 안 박습니다.** 표(`cmh_ai_secret.selectors`)에서 읽습니다.
 * 마켓이 화면을 바꾸면 그 줄만 고칩니다. 이 파일은 안 고칩니다.
 */

interface SecretRecipe {
  purpose: string;
  platformCode: string;
  label?: string | null;
  /** 비밀번호를 칠 칸. 위에서부터 해 보고 **처음 보이는 것**에 칩니다. */
  selectors: string[];
  /** 친 다음 누를 것(확인 버튼). 비어 있으면 안 누릅니다. */
  submitSelectors: string[];
  /** ⚠️ **진짜 비밀번호.** 절대 결과에 담지 않습니다. */
  value?: string | null;
  missing: boolean;
}

export interface SecretTypeResult {
  ok: boolean;
  market: string;
  purpose: string;
  /** 어디까지 갔다가 멈췄나 */
  단계: '레시피' | '칸찾기' | '입력' | '보내기';
  이유?: string;
  /** 무엇을 했는지 한 줄씩. **값은 절대 안 적습니다.** */
  한일: string[];
  url: string;
}

/** 사람처럼 한 글자씩 칩니다. 붙여넣기를 막아 둔 칸이 있습니다. */
async function 사람처럼치기(el: ReturnType<Page['locator']>, value: string): Promise<void> {
  await el.click();
  await el.fill('');
  for (const ch of value) {
    await el.pressSequentially(ch, { delay: 60 + Math.floor(Math.random() * 80) });
  }
}

export async function typeSecret(page: Page, market: string, purpose: string): Promise<SecretTypeResult> {
  const 한일: string[] = [];
  const 실패 = (단계: SecretTypeResult['단계'], 이유: string): SecretTypeResult => ({
    ok: false,
    market,
    purpose,
    단계,
    이유,
    한일,
    url: page.url(),
  });

  let recipe: SecretRecipe;
  try {
    recipe = await shopware<SecretRecipe>(
      `/api/_action/cmh-ai/secret/recipe?market=${encodeURIComponent(market)}&purpose=${encodeURIComponent(purpose)}`,
      'GET',
    );
  } catch (e) {
    return 실패('레시피', String(e instanceof Error ? e.message : e));
  }
  한일.push(`레시피 받음 (${recipe.platformCode}, ${purpose}, 칸 후보 ${recipe.selectors.length}개)`);

  if (recipe.missing || !recipe.value) {
    return 실패('레시피', `"${purpose}" 비밀번호가 표에 비어 있습니다. 어드민에서 넣어 주세요.`);
  }
  if (recipe.selectors.length === 0) {
    return 실패('레시피', `"${purpose}" 의 selectors 가 비어 있습니다. 어느 칸에 칠지 표에 넣어 주세요.`);
  }

  // 후보를 위에서부터 해 보고 **처음 보이는 것**에 칩니다.
  // 마켓이 화면을 조금씩 바꿔도 후보를 여러 개 두면 안 깨집니다.
  for (const selector of recipe.selectors) {
    const hit = await findBoth(page, selector);
    if (!hit.visible) continue;

    try {
      await 사람처럼치기(hit.target.locator(selector).first(), recipe.value);
    } catch (e) {
      return 실패('입력', String(e instanceof Error ? e.message : e).split('\n')[0]);
    }
    // ⚠️ 선택자는 적어도 됩니다(비밀이 아닙니다). **값은 적지 않습니다.**
    한일.push(`비밀번호를 칸에 넣음 (${selector}${hit.inFrame ? ', iframe 안' : ''})`);

    for (const submit of recipe.submitSelectors) {
      const s = await findBoth(page, submit);
      if (!s.visible) continue;
      await s.target
        .locator(submit)
        .first()
        .click({ timeout: 8_000 })
        .catch(() => {});
      한일.push(`확인 버튼 누름 (${submit})`);
      break;
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    return { ok: true, market, purpose, 단계: '보내기', 한일, url: page.url() };
  }

  return 실패('칸찾기', `비밀번호를 칠 칸이 화면에 안 보입니다. 후보 ${recipe.selectors.length}개를 다 봤습니다.`);
}
