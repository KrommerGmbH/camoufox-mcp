/**
 * 웹 주소만 허용합니다.
 * file:// 을 열면 이 PC 의 아무 파일이나 열어서 snapshot·screenshot 으로 내용을 뽑아낼 수 있습니다.
 * 이 도구는 웹 관리자 화면을 보려고 만든 것이므로 http/https 외에는 막습니다.
 */
export function assertWebUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`주소 형식이 아닙니다: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(
      `${u.protocol} 주소는 열 수 없습니다. http/https 만 됩니다. ` +
        `(file:// 은 이 컴퓨터의 파일을 그대로 읽어낼 수 있어 막았습니다.)`,
    );
  }
  return u.toString();
}
