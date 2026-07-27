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
}

const MAX_ENTRIES = 400;
const MAX_BODY_BYTES = 512 * 1024;

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

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** 목록만 봅니다(본문 제외). 토큰을 아끼려고 기본은 요약입니다. */
  list(filter?: string): Omit<NetEntry, 'body'>[] {
    const f = filter?.toLowerCase();
    return this.entries
      .filter((e) => !f || e.url.toLowerCase().includes(f))
      .map(({ body: _body, ...rest }) => rest);
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
