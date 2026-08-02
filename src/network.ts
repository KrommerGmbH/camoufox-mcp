import type { BrowserContext, Response } from 'playwright-core';

export interface NetEntry {
  ref: number;
  method: string;
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  at: number;
  /** JSON 응답만, 그리고 너무 크지 않을 때만 담습니다. */
  body?: unknown;
  bodyError?: string;

  /**
   * **보낸 것**(요청 본문). 저장·발송처럼 값을 바꾸는 요청에만 담깁니다.
   *
   * 왜 필요한가: "저장 버튼을 누르면 네이버에 무엇이 어떤 모양으로 가는가"를 알아야
   * 그 모양대로 보내거나 가로채서 고칠 수 있습니다. 모르면 찍는 것입니다.
   * 응답만 봐서는 알 수 없습니다 — 응답과 요청의 모양이 다를 수 있기 때문입니다.
   */
  sent?: unknown;
  /** 보낸 것이 커서 통째로 안 담았을 때, 맨 위 칸 이름만. */
  sentKeys?: string[];
  sentBytes?: number;
}

const MAX_ENTRIES = 400;
const MAX_BODY_BYTES = 512 * 1024;
/** 보낸 것을 통째로 담을 최대 크기. 이보다 크면 칸 이름만 남깁니다. */
const MAX_SENT_BYTES = 64 * 1024;
/** 값을 바꾸는 방식들. 이때만 보낸 것을 받아 적습니다. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 화면이 뒤에서 부르는 JSON 을 전부 받아 적습니다.
 * 이게 있으면 화면 글자를 긁지 않고 원본 데이터를 그대로 볼 수 있습니다.
 */
export class NetworkRecorder {
  private entries: NetEntry[] = [];
  private seq = 0;

  attach(context: BrowserContext): void {
    context.on('response', (res: Response) => {
      void this.record(res);
    });
  }

  private async record(res: Response): Promise<void> {
    const req = res.request();
    const type = req.resourceType();
    const contentType = (res.headers()['content-type'] ?? '').toLowerCase();
    const isJson = contentType.includes('json');

    // 화면 데이터는 xhr/fetch 로 옵니다. 이미지·CSS 는 버립니다.
    if (type !== 'xhr' && type !== 'fetch' && !isJson) return;

    const entry: NetEntry = {
      ref: ++this.seq,
      method: req.method(),
      url: res.url(),
      status: res.status(),
      contentType,
      bytes: 0,
      at: Date.now(),
    };

    if (isJson) {
      try {
        const buf = await res.body();
        entry.bytes = buf.length;
        if (buf.length <= MAX_BODY_BYTES) {
          entry.body = JSON.parse(buf.toString('utf8'));
        } else {
          entry.bodyError = `본문이 너무 큽니다 (${buf.length} 바이트)`;
        }
      } catch (e) {
        entry.bodyError = String(e);
      }
    }

    // 값을 바꾸는 요청이면 **보낸 것도** 받아 적습니다.
    //
    // GET 은 안 담습니다 — 보낼 것이 없고, 주소에 다 들어 있습니다.
    // 상품 저장 요청은 500KB 가 넘습니다. 통째로 담으면 목록을 볼 때마다 그 값을 내므로,
    // 크면 **맨 위 칸 이름과 크기만** 남깁니다. 그것만으로도 "어떤 모양인가"는 알 수 있습니다.
    if (WRITE_METHODS.has(entry.method)) {
      const sent = req.postData();
      if (sent) {
        entry.sentBytes = Buffer.byteLength(sent, 'utf8');
        try {
          const parsed = JSON.parse(sent);
          if (entry.sentBytes <= MAX_SENT_BYTES) entry.sent = parsed;
          else if (parsed && typeof parsed === 'object') entry.sentKeys = Object.keys(parsed).slice(0, 40);
        } catch {
          // JSON 이 아니면(폼 전송 등) 앞부분만 남깁니다.
          entry.sent = sent.slice(0, 2_000);
        }
      }
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /**
   * 목록만 봅니다. **받은 본문과 보낸 본문은 둘 다 뺍니다** — 토큰을 아끼려는 것이 목적입니다.
   * 대신 `sentBytes`(보낸 크기)는 남겨서 "이 요청이 값을 바꾸는 요청이구나"를 알 수 있게 합니다.
   * 본문이 필요하면 ref 를 골라 browser_network_body 로 봅니다.
   */
  list(filter?: string): Omit<NetEntry, 'body' | 'sent'>[] {
    const f = filter?.toLowerCase();
    return this.entries
      .filter((e) => !f || e.url.toLowerCase().includes(f))
      .map(({ body: _body, sent: _sent, ...rest }) => rest);
  }

  /**
   * **값을 바꾼 요청만** 골라 봅니다. "저장을 누르면 무엇이 어디로 가는가"를 볼 때 씁니다.
   * 목록이 400개여도 저장 요청은 보통 한두 개라서 바로 눈에 띕니다.
   */
  writes(filter?: string): Omit<NetEntry, 'body' | 'sent'>[] {
    return this.list(filter).filter((e) => WRITE_METHODS.has(e.method));
  }

  /** 하나를 골라 본문 전체를 봅니다. */
  get(ref: number): NetEntry | undefined {
    return this.entries.find((e) => e.ref === ref);
  }

  all(): NetEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}
