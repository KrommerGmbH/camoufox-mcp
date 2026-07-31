/**
 * 로그인용 창 띄우기 (1회용)
 *
 * MCP 도구가 아직 안 잡힐 때, 창만 먼저 띄워서 사람이 직접 로그인하게 합니다.
 * 로그인 정보는 프로필 폴더에 남으므로, 나중에 MCP 로 붙어도 그대로 로그인되어 있습니다.
 *
 * 실행: node scripts/open-for-login.mjs
 */
import { Camoufox } from 'camoufox-js';

const PROFILE = process.env.CAMOUFOX_MCP_PROFILE ?? 'E:/Kang/project/camoufox-mcp/.profile/naver';
const START = 'https://sell.smartstore.naver.com/';

const context = await Camoufox({
  user_data_dir: PROFILE,
  headless: false, // 사람이 직접 로그인해야 하므로 창을 띄웁니다.
  humanize: true,
  os: 'windows',
  block_images: false,
  enable_cache: true,
  geoip: false,
  window: [1600, 1000],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log('창을 띄웠습니다. 이 창에서 직접 로그인하세요.');
console.log(`프로필 폴더: ${PROFILE}`);
console.log('로그인되면 자동으로 알려드립니다. (창은 계속 열어둡니다)\n');

let loggedIn = false;
// 로그인 여부는 화면 글자가 아니라 "주소가 판매자센터로 돌아왔는지"로 판단합니다.
while (true) {
  await page.waitForTimeout(3000);
  if (page.isClosed()) {
    console.log('창이 닫혔습니다. 종료합니다.');
    break;
  }
  const url = page.url();
  const onSeller = url.includes('sell.smartstore.naver.com') && !url.includes('nid.naver.com');
  if (onSeller && !loggedIn) {
    const cookies = await context.cookies();
    const hasSession = cookies.some((c) => c.name === 'NID_AUT' || c.name === 'NID_SES');
    if (hasSession) {
      loggedIn = true;
      console.log('✅ 로그인 확인. 프로필에 저장되었습니다.');
      console.log(`   현재 주소: ${url}`);
      console.log('   이제 Claude Code 를 다시 시작하면 이 로그인 상태 그대로 이어서 조사합니다.');
      console.log('   (창은 그대로 두셔도 되고 닫으셔도 됩니다. 로그인은 남습니다.)');
    }
  }
}

await context.close().catch(() => {});
