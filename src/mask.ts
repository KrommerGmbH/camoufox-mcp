/**
 * 개인정보 가리기.
 *
 * 주문 화면에는 고객 이름·주소·전화번호가 그대로 들어 있습니다.
 * 우리가 알아야 할 것은 **어떤 이름의 칸이 있는가** 이지 **그 값** 이 아닙니다.
 * 그래서 값만 가리고 구조는 남깁니다. (독일 GmbH 라 GDPR 도 걸립니다)
 *
 * 가리는 기준은 "칸 이름" 입니다. 값을 보고 추측하면 놓치거나 멀쩡한 걸 지웁니다.
 */

/** 이 낱말이 칸 이름에 들어 있으면 값을 가립니다. */
const PII_KEY =
  /(^|_|\.)?(name|nm|tel|phone|mobile|hp|cell|addr|address|zip|post|email|mail|receiver|recipient|orderer|buyer|member|customer|account|birth|ssn|card|bank|account_?no|accountNumber|passwd|password|token|secret)/i;

/** 값만 봐도 개인정보인 것. 칸 이름이 이상해도 이건 가립니다. */
const PII_VALUE: Array<[RegExp, string]> = [
  [/\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g, '010-****-****'], // 휴대폰
  [/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '0**-****-****'], // 유선전화
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***.***'], // 메일
  [/\b\d{6}[-\s]?[1-4]\d{6}\b/g, '******-*******'], // 주민번호
];

/** 칸 이름은 그대로 두고 값만 별표로 바꿉니다. 길이는 대충 남겨서 형식을 알 수 있게 합니다. */
function maskValue(v: string): string {
  if (!v) return v;
  if (v.length <= 2) return '**';
  return `${v[0]}${'*'.repeat(Math.min(v.length - 1, 8))}`;
}

function maskText(s: string): string {
  let out = s;
  for (const [re, rep] of PII_VALUE) out = out.replace(re, rep);
  return out;
}

/**
 * JSON 을 훑으면서 개인정보 칸의 값을 가립니다.
 * 원본은 건드리지 않고 새 값을 돌려줍니다.
 */
export function maskJson(input: unknown, depth = 0): unknown {
  if (depth > 12) return input;
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return maskText(input);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => maskJson(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (PII_KEY.test(k) && typeof v === 'string') {
      out[k] = maskValue(v);
    } else if (PII_KEY.test(k) && typeof v === 'number') {
      // 번호형(회원번호 등)은 자릿수만 남깁니다.
      out[k] = Number(String(v).replace(/\d(?=\d{2})/g, '0'));
    } else {
      out[k] = maskJson(v, depth + 1);
    }
  }
  return out;
}

/** 화면 글·요소 이름에서도 전화번호·메일을 가립니다. */
export function maskString(s: string | null | undefined): string | null | undefined {
  return typeof s === 'string' ? maskText(s) : s;
}

/**
 * 가린 뒤에 **정말 다 가려졌는지** 다시 훑습니다.
 *
 * 왜 필요한가: 가리기가 조용히 안 돌아도 파일은 멀쩡해 보입니다.
 * 실측으로 조사 파일 27개에 고객 이름·주소·전화 95건이 그대로 남아 있었는데,
 * 아무도 몰랐던 이유가 이것입니다. 그래서 저장할 때마다 스스로 셉니다.
 *
 * 값이 이미 별표로 바뀌었으면 새는 것으로 세지 않습니다.
 */
export function countLeaks(input: unknown, depth = 0): Array<{ key: string; sample: string }> {
  const found: Array<{ key: string; sample: string }> = [];
  if (depth > 12 || input === null || typeof input !== 'object') return found;

  if (Array.isArray(input)) {
    for (const v of input) found.push(...countLeaks(v, depth + 1));
    return found;
  }

  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() !== '' && PII_KEY.test(k)) {
      // 이미 가려진 값은 별표뿐입니다. 그 밖의 글자가 있으면 안 가려진 것입니다.
      if (!/^[*]+$/.test(v) && !/^.[*]+$/.test(v) && !v.includes('***')) {
        found.push({ key: k, sample: v.slice(0, 2) + '…' });
      }
    } else if (typeof v === 'object') {
      found.push(...countLeaks(v, depth + 1));
    }
  }

  return found;
}
