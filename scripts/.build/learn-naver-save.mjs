// src/browser.ts
import path2 from "node:path";
import { Camoufox } from "camoufox-js";

// src/network.ts
var MAX_ENTRIES = 400;
var MAX_BODY_BYTES = 512 * 1024;
var MAX_SENT_BYTES = 64 * 1024;
var WRITE_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
var NetworkRecorder = class {
  entries = [];
  seq = 0;
  attach(context3) {
    context3.on("response", (res) => {
      void this.record(res);
    });
  }
  async record(res) {
    const req = res.request();
    const type = req.resourceType();
    const contentType = (res.headers()["content-type"] ?? "").toLowerCase();
    const isJson = contentType.includes("json");
    if (type !== "xhr" && type !== "fetch" && !isJson) return;
    const entry = {
      ref: ++this.seq,
      method: req.method(),
      url: res.url(),
      status: res.status(),
      contentType,
      bytes: 0,
      at: Date.now()
    };
    if (isJson) {
      try {
        const buf = await res.body();
        entry.bytes = buf.length;
        if (buf.length <= MAX_BODY_BYTES) {
          entry.body = JSON.parse(buf.toString("utf8"));
        } else {
          entry.bodyError = `\uBCF8\uBB38\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4 (${buf.length} \uBC14\uC774\uD2B8)`;
        }
      } catch (e) {
        entry.bodyError = String(e);
      }
    }
    if (WRITE_METHODS.has(entry.method)) {
      const sent = req.postData();
      if (sent) {
        entry.sentBytes = Buffer.byteLength(sent, "utf8");
        try {
          const parsed = JSON.parse(sent);
          if (entry.sentBytes <= MAX_SENT_BYTES) entry.sent = parsed;
          else if (parsed && typeof parsed === "object") entry.sentKeys = Object.keys(parsed).slice(0, 40);
        } catch {
          entry.sent = sent.slice(0, 2e3);
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
  list(filter) {
    const f = filter?.toLowerCase();
    return this.entries.filter((e) => !f || e.url.toLowerCase().includes(f)).map(({ body: _body, sent: _sent, ...rest }) => rest);
  }
  /**
   * **값을 바꾼 요청만** 골라 봅니다. "저장을 누르면 무엇이 어디로 가는가"를 볼 때 씁니다.
   * 목록이 400개여도 저장 요청은 보통 한두 개라서 바로 눈에 띕니다.
   */
  writes(filter) {
    return this.list(filter).filter((e) => WRITE_METHODS.has(e.method));
  }
  /** 하나를 골라 본문 전체를 봅니다. */
  get(ref) {
    return this.entries.find((e) => e.ref === ref);
  }
  all() {
    return [...this.entries];
  }
  clear() {
    this.entries = [];
  }
};

// src/popup.ts
var DONT_SHOW_INPUT = 'input[name="again"], input[name="todayClose"], input[name="notToday"]';
var BOX = '[role="dialog"], .modal-content, .layer_popup, .seller-layer-modal';
var CLOSE = [
  "button.close",
  "button.btn-default2",
  '[aria-label="\uB2EB\uAE30"]',
  '[aria-label="Close"]',
  'button:text-is("\uB2EB\uAE30")',
  'button:text-is("Close")',
  'a:text-is("\uB2EB\uAE30")'
].join(", ");
var NEVER = /입력하기|신청|등록|삭제|저장|동의|결제|발송|승인|제출|이동하기|구매|주문/;
async function buttonLabel(el) {
  const aria = (await el.getAttribute("aria-label").catch(() => null))?.trim();
  if (aria) return aria.slice(0, 30);
  const title = (await el.getAttribute("title").catch(() => null))?.trim();
  if (title) return title.slice(0, 30);
  const raw = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  return raw.slice(0, 30);
}
async function firstVisible(page3, selector) {
  const loc = page3.locator(selector);
  const n = await loc.count();
  for (let i = 0; i < Math.min(n, 10); i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}
async function closeLayerPopups(page3, opt = {}) {
  const inputSel = opt.dontShowSelector ?? DONT_SHOW_INPUT;
  const boxSel = opt.boxSelector ?? BOX;
  const closeSel = opt.closeSelector ?? CLOSE;
  const report = { found: 0, actions: [], remaining: [] };
  for (let round = 0; round < 6; round++) {
    const label = await firstVisible(page3, `label:has(${inputSel})`);
    const box = label ? null : await firstVisible(page3, boxSel);
    if (!label && !box) break;
    report.found++;
    const action = { title: "", checkedDontShow: false, closed: false, how: "" };
    const boxLoc = label ? page3.locator(boxSel).filter({ has: page3.locator(inputSel) }).first() : box;
    action.title = (await boxLoc.locator(".modal-title, h1, h2, h3, strong").first().innerText({ timeout: 2e3 }).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 60) || "(\uC81C\uBAA9 \uC5C6\uC74C)";
    if (label) {
      await label.click({ timeout: 5e3 }).catch((e) => {
        action.how += `\uB77C\uBCA8 \uD074\uB9AD \uC2E4\uD328(${String(e).split("\n")[0]}). `;
      });
      action.checkedDontShow = await page3.locator(inputSel).first().isChecked().catch(() => false);
      const gone = !await boxLoc.isVisible().catch(() => false);
      if (gone) action.checkedDontShow = true;
      action.how += action.checkedDontShow ? '"\uD558\uB8E8 \uB3D9\uC548 \uBCF4\uC9C0 \uC54A\uAE30" \uCC98\uB9AC\uB428. ' : "\uCCB4\uD06C \uD655\uC778 \uC548 \uB428. ";
    } else {
      action.how += "\uCCB4\uD06C\uBC15\uC2A4 \uC5C6\uC74C. ";
    }
    if (await boxLoc.isVisible().catch(() => false)) {
      const closer = await firstVisible(page3, `${boxSel} :is(${closeSel})`);
      if (closer) {
        const t = await buttonLabel(closer);
        if (NEVER.test(t)) {
          action.how += `\uB2EB\uAE30 \uD6C4\uBCF4\uAC00 \uC704\uD5D8\uD55C \uBC84\uD2BC("${t}")\uC774\uB77C \uC548 \uB20C\uB800\uC2B5\uB2C8\uB2E4. `;
        } else {
          await closer.click({ timeout: 5e3 }).catch((e) => {
            action.how += `\uB2EB\uAE30 \uD074\uB9AD \uC2E4\uD328(${String(e).split("\n")[0]}). `;
          });
          action.how += `\uB2EB\uAE30 \uD074\uB9AD("${t || "X"}"). `;
        }
      } else {
        await page3.keyboard.press("Escape").catch(() => {
        });
        action.how += "\uB2EB\uAE30 \uBC84\uD2BC\uC744 \uBABB \uCC3E\uC544 Esc. ";
      }
    }
    await page3.waitForTimeout(500);
    action.closed = !await boxLoc.isVisible().catch(() => false);
    action.how += action.closed ? "\uC0AC\uB77C\uC9C4 \uAC83 \uD655\uC778." : "\uC544\uC9C1 \uB0A8\uC544 \uC788\uC74C.";
    report.actions.push(action);
    if (!action.closed) {
      report.remaining.push(action.title);
      break;
    }
  }
  return report;
}
function watchPopupWindows(context3, log) {
  context3.on("page", async (p) => {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 1e4 }).catch(() => {
      });
      await closeLayerPopups(p).catch(() => null);
      log(`\uC0C8 \uCC3D\uC774 \uC5F4\uB838\uC2B5\uB2C8\uB2E4: ${p.url()}`);
    } catch {
    }
  });
}

// src/screen.ts
import { execFileSync } from "node:child_process";
var HEADLESS_SIZE = { width: 1280, height: 800, source: "headless-\uAE30\uBCF8\uAC12" };
var FALLBACK = { width: 1600, height: 1e3, source: "\uD3F4\uBC31" };
function primaryWorkArea() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        'Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output "$($s.Width)x$($s.Height)"'
      ],
      { encoding: "utf8", windowsHide: true, timeout: 1e4 }
    );
    const m = out.trim().match(/(\d+)x(\d+)/);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]), source: "\uC8FC \uBAA8\uB2C8\uD130 \uC791\uC5C5 \uC601\uC5ED" };
  } catch {
    return null;
  }
}
function pickWindowSize(headless) {
  if (headless) return HEADLESS_SIZE;
  return primaryWorkArea() ?? FALLBACK;
}
function viewportFor(size) {
  return { width: size.width, height: Math.max(400, size.height - 110) };
}

// src/session.ts
import fs from "node:fs";
import path from "node:path";
function sessionFile(profileDir) {
  return path.join(path.dirname(profileDir), `${path.basename(profileDir)}.session.json`);
}
async function saveSession(context3, profileDir) {
  const state = await context3.storageState();
  const file = sessionFile(profileDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 384);
  try {
    fs.writeSync(fd, JSON.stringify(state));
  } finally {
    fs.closeSync(fd);
  }
  return state.cookies.length;
}
async function restoreSession(context3, profileDir) {
  const file = sessionFile(profileDir);
  const none = { restored: 0, skipped: 0, ageHours: null, from: null };
  if (!fs.existsSync(file)) return none;
  try {
    const ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 36e5;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const all = state.cookies ?? [];
    const now = Date.now() / 1e3;
    const fresh = all.filter((c) => !c.expires || c.expires === -1 || c.expires > now);
    if (!fresh.length) return { ...none, skipped: all.length, ageHours, from: file };
    await context3.addCookies(fresh);
    return { restored: fresh.length, skipped: all.length - fresh.length, ageHours, from: file };
  } catch {
    return { ...none, from: file };
  }
}

// src/browser.ts
var major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  throw new Error(
    `Node ${process.versions.node} \uC740(\uB294) \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. Node 22 \uC774\uC0C1\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.
Node 21 \uC5D0\uC11C\uB294 \uBE0C\uB77C\uC6B0\uC800\uB97C \uB744\uC6B0\uB2E4\uAC00 \uD504\uB85C\uC138\uC2A4\uAC00 \uC870\uC6A9\uD788 \uC8FD\uC2B5\uB2C8\uB2E4.
\uD574\uACB0: nvm install 22 && nvm use 22 (Windows \uB294 PATH \uC5D0 v21 \uACBD\uB85C\uAC00 \uBC15\uD600 \uC788\uC73C\uBA74 \uBA3C\uC800 \uC9C0\uC6B0\uC138\uC694)`
  );
}
var context = null;
var page = null;
var recorder = null;
var openedAt = 0;
var lastSize = null;
var currentProfile = "";
var lastSession = null;
function defaultProfileDir() {
  return process.env.CAMOUFOX_MCP_PROFILE ?? path2.resolve(process.cwd(), ".profile", "default");
}
async function openBrowser(opts = {}) {
  if (context && page && recorder && !page.isClosed()) {
    return { page, context, recorder, reused: true, restoredCookies: 0 };
  }
  const profileDir = opts.profileDir ?? defaultProfileDir();
  const headless = opts.headless ?? false;
  const size = opts.window ? { width: opts.window[0], height: opts.window[1], source: "\uC9C1\uC811 \uC9C0\uC815" } : pickWindowSize(headless);
  const viewport = viewportFor(size);
  lastSize = size;
  context = await Camoufox({
    user_data_dir: profileDir,
    headless,
    // 사람처럼 곡선을 그리는 마우스 (Camoufox 내장, 커서 전용).
    //
    // **숫자로 상한을 줘야 합니다.** `true` 는 상한이 없어서, 2560px 짜리 넓은 창에서는
    // 마우스가 화면을 한 번 가로지르는 데 **57초**가 걸렸습니다(2026-08-01 실측).
    // 그러면 Playwright 의 클릭이 시간초과로 죽고, 좌표로 찍는 마지막 수단으로 떨어집니다.
    // 좌표 클릭은 스크롤이 어긋나면 빗나가는데, **빗나가도 "눌렀다"고 답합니다.**
    // 오늘 연령 체크박스가 안 눌린 진짜 원인이 이것이었습니다.
    // 0.7초면 사람이 마우스를 휙 옮기는 속도와 비슷하고, 곡선도 그대로 그립니다.
    humanize: 0.7,
    os: "windows",
    block_images: opts.blockImages ?? false,
    enable_cache: true,
    geoip: false,
    // 프록시를 켤 때만 true 로 바꾸세요.
    // window 는 지문에, viewport 는 실제 창 크기에 반영됩니다. 둘을 맞춰야 어긋나지 않습니다.
    window: [size.width, size.height],
    viewport,
    ...opts.proxy ? { proxy: opts.proxy } : {}
    // locale 은 일부러 지정하지 않습니다.
    // 실제 IP 와 언어가 어긋나면 그게 오히려 눈에 띄는 신호가 됩니다.
  });
  recorder = new NetworkRecorder();
  recorder.attach(context);
  watchPopupWindows(context, (m) => process.stderr.write(`[popup] ${m}
`));
  const sess = await restoreSession(context, profileDir);
  lastSession = sess;
  if (sess.restored || sess.skipped) {
    process.stderr.write(
      `[session] \uBCF5\uC6D0 ${sess.restored}\uAC1C / \uB9CC\uB8CC\uB85C \uBC84\uB9BC ${sess.skipped}\uAC1C` + (sess.ageHours !== null ? ` / \uC800\uC7A5\uB41C \uC9C0 ${sess.ageHours.toFixed(1)}\uC2DC\uAC04` : "") + "\n"
    );
  }
  if (sess.ageHours !== null && sess.ageHours > 6) {
    process.stderr.write(
      `[session] \uC800\uC7A5\uD55C \uC9C0 ${sess.ageHours.toFixed(0)}\uC2DC\uAC04 \uC9C0\uB0AC\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uB85C\uADF8\uC778\uD574\uC57C \uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.
`
    );
  }
  page = context.pages()[0] ?? await context.newPage();
  openedAt = Date.now();
  currentProfile = profileDir;
  {
    const t0 = Date.now();
    await page.mouse.move(300, 300).catch(() => {
    });
    await page.mouse.down().catch(() => {
    });
    await page.mouse.up().catch(() => {
    });
    process.stderr.write(`[mouse] \uC608\uC5F4 ${((Date.now() - t0) / 1e3).toFixed(1)}\uCD08 (\uCCAB \uD074\uB9AD\uC774 \uC8FD\uB294 \uAC83\uC744 \uB9C9\uC2B5\uB2C8\uB2E4)
`);
  }
  return { page, context, recorder, reused: false, restoredCookies: sess.restored };
}
async function saveNow() {
  if (!context) return 0;
  return saveSession(context, currentProfile || defaultProfileDir()).catch(() => 0);
}
async function closeBrowser() {
  if (!context) return false;
  await saveNow();
  await context.close().catch(() => {
  });
  context = null;
  page = null;
  recorder = null;
  return true;
}

// src/frame.ts
var COVER_RATIO = 0.6;
async function contentTarget(page3) {
  const frames = page3.frames().filter((f) => f !== page3.mainFrame());
  if (!frames.length) {
    return { target: page3, inFrame: false, frameUrl: null, frameCount: 0 };
  }
  const view = page3.viewportSize() ?? { width: 1920, height: 1080 };
  const area = view.width * view.height;
  let best = null;
  for (const f of frames) {
    const el = await f.frameElement().catch(() => null);
    if (!el) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box) continue;
    const size = box.width * box.height;
    if (size / area < COVER_RATIO) continue;
    if (!best || size > best.size) best = { frame: f, size };
  }
  if (!best) {
    return { target: page3, inFrame: false, frameUrl: null, frameCount: frames.length };
  }
  return {
    target: best.frame,
    inFrame: true,
    frameUrl: best.frame.url(),
    frameCount: frames.length
  };
}

// src/locate.ts
var WAYS = [
  { how: "role=button", make: (t, q) => t.getByRole("button", { name: q, exact: true }) },
  { how: "role=link", make: (t, q) => t.getByRole("link", { name: q, exact: true }) },
  { how: "label", make: (t, q) => t.getByLabel(q, { exact: true }) },
  { how: "placeholder", make: (t, q) => t.getByPlaceholder(q, { exact: true }) },
  // 여기부터는 부분 일치. 위에서 못 찾았을 때만 씁니다.
  { how: "role=button(\uBD80\uBD84)", make: (t, q) => t.getByRole("button", { name: q }) },
  { how: "role=checkbox", make: (t, q) => t.getByRole("checkbox", { name: q }) },
  { how: "role=radio", make: (t, q) => t.getByRole("radio", { name: q }) },
  { how: "label(\uBD80\uBD84)", make: (t, q) => t.getByLabel(q) },
  { how: "placeholder(\uBD80\uBD84)", make: (t, q) => t.getByPlaceholder(q) },
  { how: "text", make: (t, q) => t.getByText(q, { exact: false }) }
];
async function pickVisible(loc, nth) {
  const total = await loc.count().catch(() => 0);
  const seen = [];
  for (let i = 0; i < Math.min(total, 40); i++) {
    const one = loc.nth(i);
    if (await one.isVisible().catch(() => false)) seen.push(one);
  }
  return seen[nth] ? { one: seen[nth], visible: seen.length } : null;
}
async function locate(page3, q) {
  const frame = await contentTarget(page3);
  const targets2 = [{ t: page3, inFrame: false }];
  if (frame.inFrame) targets2.push({ t: frame.target, inFrame: true });
  const nth = q.nth ?? 0;
  if (q.ref) {
    const t = q.ref.startsWith("f") && frame.inFrame ? frame.target : page3;
    return {
      locator: t.locator(`[data-cfx-ref="${q.ref}"]`),
      how: `ref=${q.ref}`,
      inFrame: q.ref.startsWith("f"),
      matches: 1
      // ref 는 요소 하나에만 찍혀 있어서 겹칠 수가 없습니다.
    };
  }
  if (q.selector) {
    for (const { t, inFrame } of targets2) {
      const hit = await pickVisible(t.locator(q.selector), nth);
      if (hit) {
        return { locator: hit.one, how: `selector${inFrame ? "(iframe)" : ""}`, inFrame, matches: hit.visible };
      }
    }
    throw new Error(`\uC120\uD0DD\uC790\uB85C \uBABB \uCC3E\uC558\uC2B5\uB2C8\uB2E4: ${q.selector}`);
  }
  if (q.text) {
    for (const way of WAYS) {
      for (const { t, inFrame } of targets2) {
        const hit = await pickVisible(way.make(t, q.text), nth).catch(() => null);
        if (hit) {
          return { locator: hit.one, how: `${way.how}${inFrame ? "(iframe)" : ""}`, inFrame, matches: hit.visible };
        }
      }
    }
    throw new Error(
      `"${q.text}" \uB97C \uD654\uBA74\uC5D0\uC11C \uBABB \uCC3E\uC558\uC2B5\uB2C8\uB2E4. browser_snapshot({find:"${q.text.slice(0, 6)}"}) \uB85C \uBB50\uAC00 \uC788\uB294\uC9C0 \uBCF4\uC138\uC694.`
    );
  }
  throw new Error("ref \xB7 text \xB7 selector \uC911 \uD558\uB098\uB294 \uC8FC\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
}

// src/snapshot.ts
async function snapshot(target, opts = {}, prefix = "e") {
  return target.evaluate(
    ({ max, pfx, find, only, verbose }) => {
      const CAP = "data-cfx-ref";
      document.querySelectorAll(`[${CAP}]`).forEach((el) => el.removeAttribute(CAP));
      const cut = (s, n2 = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n2);
      const accName = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria) return cut(aria);
        const by = el.getAttribute("aria-labelledby");
        if (by) {
          const t = by.split(/\s+/).map((id2) => document.getElementById(id2)?.textContent ?? "").join(" ");
          if (t.trim()) return cut(t);
        }
        const id = el.getAttribute("id");
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab?.textContent?.trim()) return cut(lab.textContent);
        }
        const wrapLab = el.closest("label");
        if (wrapLab?.textContent?.trim()) return cut(wrapLab.textContent);
        const title = el.getAttribute("title");
        if (title) return cut(title);
        return cut(el.innerText || el.textContent);
      };
      const generated = (token2) => /^(css|sc|jsx|emotion|_)[-_]?[0-9a-z]{4,}$/i.test(token2) || /^[a-z]{1,3}[0-9]{4,}$/i.test(token2) || /^ng-/.test(token2);
      const stableClasses = (el) => Array.from(el.classList).filter((c) => !generated(c)).slice(0, 2);
      const cssPath = (el) => {
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 6) {
          const id = cur.getAttribute("id");
          if (id && !generated(id)) {
            parts.unshift(`#${CSS.escape(id)}`);
            break;
          }
          let seg = cur.tagName.toLowerCase();
          const cls = stableClasses(cur);
          if (cls.length) seg += cls.map((c) => `.${CSS.escape(c)}`).join("");
          const parent = cur.parentElement;
          if (parent) {
            const sibs = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
            if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
          }
          parts.unshift(seg);
          cur = parent;
          depth++;
        }
        return parts.join(" > ");
      };
      const SEL = 'a,button,input,select,textarea,[role],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
      const elements = [];
      let n = 0;
      let truncated = false;
      let totalOnScreen = 0;
      const needle = (find ?? "").trim().toLowerCase();
      const CLICKABLE = /* @__PURE__ */ new Set(["a", "button"]);
      const INPUTS = /* @__PURE__ */ new Set(["input", "select", "textarea"]);
      for (const el of Array.from(document.querySelectorAll(SEL))) {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const tagLower = el.tagName.toLowerCase();
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (box.width === 0 || box.height === 0) {
          const lab = el.closest("label");
          const labBox = lab?.getBoundingClientRect();
          if (!labBox || labBox.width === 0 || labBox.height === 0) continue;
        }
        totalOnScreen++;
        if (only === "click" && !CLICKABLE.has(tagLower) && el.getAttribute("role") !== "button") continue;
        if (only === "input" && !INPUTS.has(tagLower)) continue;
        if (needle) {
          const hay = [
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
            el.getAttribute("name"),
            el.getAttribute("id"),
            el.getAttribute("value"),
            el.innerText,
            el.closest("label")?.textContent
          ].join(" ").toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        if (n >= max) {
          truncated = true;
          break;
        }
        const ref = `${pfx}${++n}`;
        el.setAttribute(CAP, ref);
        const tag = el.tagName.toLowerCase();
        const name = accName(el);
        const role = el.getAttribute("role") ?? void 0;
        const placeholder = el.getAttribute("placeholder") ?? void 0;
        const selectors = [];
        for (const a of ["data-testid", "data-test", "data-cy", "data-qa"]) {
          const v = el.getAttribute(a);
          if (v) selectors.push({ strategy: "testid", expression: `[${a}="${v}"]` });
        }
        const id = el.getAttribute("id");
        if (id && !generated(id)) selectors.push({ strategy: "css", expression: `#${id}` });
        const nm = el.getAttribute("name");
        if (nm) selectors.push({ strategy: "css", expression: `${tag}[name="${nm}"]` });
        if (role && name) selectors.push({ strategy: "role", expression: `${role}|${name}` });
        if (placeholder) selectors.push({ strategy: "placeholder", expression: placeholder });
        if (name && (tag === "button" || tag === "a")) {
          selectors.push({ strategy: "text", expression: name });
        }
        selectors.push({ strategy: "css", expression: cssPath(el) });
        const keep = verbose ? selectors : selectors.slice(0, 2);
        const item = { ref, tag, name: name || void 0, selectors: keep };
        if (role) item.role = role;
        if (placeholder) item.placeholder = placeholder;
        const t = el.getAttribute("type");
        if (t) item.type = t;
        if (el.disabled) item.disabled = true;
        const val = el.value;
        if (val && tag !== "select") item.value = cut(val, 40);
        const txt = cut(el.innerText, 60);
        if (txt && txt !== name) item.text = txt;
        if (tag === "select") {
          item.options = Array.from(el.options).map((o) => ({
            value: o.value,
            text: cut(o.textContent, 60)
          }));
        }
        elements.push(item);
      }
      const sameSel = /* @__PURE__ */ new Map();
      for (const it of elements) {
        const s = it.selectors[0];
        if (!s) continue;
        const key = `${s.strategy}|${s.expression}`;
        const list = sameSel.get(key);
        if (list) list.push(it);
        else sameSel.set(key, [it]);
      }
      for (const list of sameSel.values()) {
        if (list.length > 1) list.forEach((it, i) => it.nth = i);
      }
      const tables = Array.from(document.querySelectorAll("table")).slice(0, 10).map((tb) => ({
        caption: cut(tb.querySelector("caption")?.textContent, 60) || void 0,
        headers: Array.from(tb.querySelectorAll("thead th, tr:first-child th")).map(
          (th) => cut(th.textContent, 40)
        ),
        sampleRow: Array.from(tb.querySelectorAll("tbody tr:first-child td")).map(
          (td) => cut(td.textContent, 40)
        )
      })).filter((t) => t.headers.length > 0);
      return { url: location.href, title: document.title, elements, tables, truncated, totalOnScreen };
    },
    {
      max: opts.limit ?? 400,
      pfx: prefix,
      find: opts.find ?? "",
      only: opts.only ?? "all",
      verbose: opts.verbose ?? false
    }
  );
}

// src/act.ts
async function targets(page3) {
  const frame = await contentTarget(page3);
  const list = [{ t: page3, inFrame: false }];
  if (frame.inFrame) list.push({ t: frame.target, inFrame: true });
  return list;
}
async function countVisible(loc) {
  const total = await loc.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < Math.min(total, 20); i++) {
    const one = loc.nth(i);
    if (await one.isVisible().catch(() => false)) out.push(one);
  }
  return out;
}
async function bySelectors(page3, selectors) {
  const \uACB9\uCE68 = [];
  for (const sel of selectors) {
    for (const { t } of await targets(page3)) {
      const hits = await countVisible(t.locator(sel)).catch(() => []);
      if (hits.length === 1) return { el: hits[0], used: sel };
      if (hits.length > 1) \uACB9\uCE68.push({ selector: sel, \uAC1C\uC218: hits.length });
    }
  }
  return { \uACB9\uCE68 };
}
async function hint(page3, needle) {
  if (!needle) return [];
  const snap2 = await snapshot(page3, { find: needle.slice(0, 6), limit: 8 }).catch(() => null);
  return (snap2?.elements ?? []).map((e) => ({
    tag: e.tag,
    name: e.name,
    nth: e.nth,
    selector: e.selectors[0]?.expression
  }));
}
async function verify(page3, exp, urlBefore, el) {
  const timeout = exp.timeoutMs ?? 8e3;
  if (exp.gone) {
    for (const { t } of await targets(page3)) {
      const ok = await t.getByText(exp.gone, { exact: false }).first().waitFor({ state: "hidden", timeout }).then(() => true).catch(() => false);
      if (ok) return null;
    }
    return `"${exp.gone}" \uAC00 \uC544\uC9C1 \uD654\uBA74\uC5D0 \uC788\uC2B5\uB2C8\uB2E4`;
  }
  if (exp.appears) {
    for (const { t } of await targets(page3)) {
      const ok = await t.getByText(exp.appears, { exact: false }).first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
      if (ok) return null;
    }
    return `"${exp.appears}" \uAC00 \uD654\uBA74\uC5D0 \uC548 \uB098\uD0C0\uB0AC\uC2B5\uB2C8\uB2E4`;
  }
  if (exp.urlChanged) {
    const ok = await page3.waitForFunction((before) => location.href !== before, urlBefore, { timeout }).then(() => true).catch(() => false);
    return ok ? null : `\uC8FC\uC18C\uAC00 \uADF8\uB300\uB85C\uC785\uB2C8\uB2E4 (${urlBefore})`;
  }
  if (exp.checked !== void 0) {
    const now = await el.isChecked().catch(() => null);
    return now === exp.checked ? null : `\uCCB4\uD06C \uC0C1\uD0DC\uAC00 ${now} \uC785\uB2C8\uB2E4 (${exp.checked} \uC774\uC5B4\uC57C \uD568)`;
  }
  if (exp.value !== void 0) {
    const now = await el.inputValue().catch(() => null);
    return now === exp.value ? null : `\uCE78\uC758 \uAC12\uC774 "${now}" \uC785\uB2C8\uB2E4 ("${exp.value}" \uC774\uC5B4\uC57C \uD568)`;
  }
  return null;
}
async function act(page3, plan) {
  const urlBefore = page3.url();
  const needle = plan.text ?? plan.selectors?.[0];
  let el = null;
  let used = "";
  let \uACB9\uCE68\uBAA9\uB85D = [];
  if (plan.selectors?.length) {
    const r2 = await bySelectors(page3, plan.selectors);
    if ("el" in r2) {
      el = r2.el;
      used = r2.used;
    } else {
      \uACB9\uCE68\uBAA9\uB85D = r2.\uACB9\uCE68;
    }
  }
  if (!el && plan.text) {
    const found = await locate(page3, { text: plan.text }).catch(() => null);
    if (found && found.matches === 1) {
      el = found.locator;
      used = `\uAE00\uC790:${plan.text} (${found.how})`;
    } else if (found) {
      \uACB9\uCE68\uBAA9\uB85D.push({ selector: `\uAE00\uC790:${plan.text}`, \uAC1C\uC218: found.matches });
    }
  }
  if (!el) {
    const \uACB9\uCCE4\uB098 = \uACB9\uCE68\uBAA9\uB85D.length > 0;
    return {
      ok: false,
      \uB2E8\uACC4: "\uCC3E\uAE30",
      \uC774\uC720: \uACB9\uCCE4\uB098 ? `\uC5EC\uB7EC \uAC1C\uAC00 \uAC78\uB824\uC11C \uC548 \uB20C\uB800\uC2B5\uB2C8\uB2E4: ${\uACB9\uCE68\uBAA9\uB85D.map((c) => `${c.selector} \u2192 ${c.\uAC1C\uC218}\uAC1C`).join(" \xB7 ")}. \uC5B4\uB290 \uAC83\uC778\uC9C0 \uC815\uD574\uC11C \uB2E4\uC2DC \uBD80\uB974\uC138\uC694. \uCC0D\uC5B4\uC11C \uB204\uB974\uBA74 \uC5C9\uB6B1\uD55C \uAC83\uC744 \uB204\uB985\uB2C8\uB2E4.` : "\uC120\uD0DD\uC790\uB85C\uB3C4 \uAE00\uC790\uB85C\uB3C4 \uBABB \uCC3E\uC558\uC2B5\uB2C8\uB2E4. \uD654\uBA74\uC774 \uBC14\uB00C\uC5C8\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
      url: urlBefore,
      \uD6C4\uBCF4: await hint(page3, needle)
    };
  }
  const CLICK_MS = 2e4;
  try {
    if (plan.do === "type") {
      await el.click({ timeout: CLICK_MS });
      await el.fill("");
      for (const ch of plan.value ?? "") {
        await el.pressSequentially(ch, { delay: 60 + Math.floor(Math.random() * 80) });
      }
    } else {
      await el.click({ timeout: CLICK_MS });
    }
  } catch (e) {
    await el.scrollIntoViewIfNeeded({ timeout: 5e3 }).catch(() => {
    });
    const retried = await el.click({ force: true, timeout: 1e4 }).then(() => true).catch(() => false);
    if (!retried) {
      return {
        ok: false,
        \uB2E8\uACC4: "\uC2E4\uD589",
        \uC4F4\uAC83: used,
        \uC774\uC720: String(e).split("\n")[0],
        url: page3.url(),
        \uD6C4\uBCF4: await hint(page3, needle)
      };
    }
  }
  await page3.waitForLoadState("networkidle", { timeout: 1e4 }).catch(() => {
  });
  if (plan.expect) {
    const bad = await verify(page3, plan.expect, urlBefore, el);
    if (bad) {
      return {
        ok: false,
        \uB2E8\uACC4: "\uD655\uC778",
        \uC4F4\uAC83: used,
        \uC774\uC720: "\uB20C\uB800\uC9C0\uB9CC \uAE30\uB300\uD55C \uACB0\uACFC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
        \uAE30\uB300: JSON.stringify(plan.expect),
        \uC2E4\uC81C: bad,
        url: page3.url(),
        \uD6C4\uBCF4: await hint(page3, plan.expect.gone ?? plan.expect.appears ?? needle)
      };
    }
  }
  return { ok: true, \uC4F4\uAC83: used, url: page3.url() };
}

// src/login.ts
var BASE = (process.env.SHOPWARE_API_URL ?? "").replace(/\/+$/, "");
var CLIENT_ID = process.env.SHOPWARE_API_CLIENT_ID ?? "";
var CLIENT_SECRET = process.env.SHOPWARE_API_CLIENT_SECRET ?? "";
var token = "";
var tokenUntil = 0;
async function shopware(path5, method, body) {
  if (!BASE || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SHOPWARE_API_URL \xB7 SHOPWARE_API_CLIENT_ID \xB7 SHOPWARE_API_CLIENT_SECRET \uC744 \uC774 \uC11C\uBC84\uC758 \uD658\uACBD\uBCC0\uC218\uB85C \uC8FC\uC138\uC694.\n\uBE44\uBC00\uBC88\uD638\uB97C \uAEBC\uB0B4\uC624\uB294 \uACF3\uC774 \uC0F5\uC6E8\uC5B4\uB77C\uC11C \uD544\uC694\uD569\uB2C8\uB2E4."
    );
  }
  if (!token || Date.now() > tokenUntil - 3e4) {
    const res2 = await fetch(`${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    });
    if (!res2.ok) throw new Error(`\uC0F5\uC6E8\uC5B4 \uB85C\uADF8\uC778 \uC2E4\uD328 (${res2.status}). \uD1B5\uD569 \uD0A4\uB97C \uD655\uC778\uD558\uC138\uC694.`);
    const b = await res2.json();
    token = b.access_token;
    tokenUntil = Date.now() + b.expires_in * 1e3;
  }
  const res = await fetch(`${BASE}${path5}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: method === "POST" ? JSON.stringify(body ?? {}) : void 0
  });
  const txt = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch {
    throw new Error(`${path5} \uC2E4\uD328 (${res.status}): ${txt.slice(0, 200)}`);
  }
  const o = parsed;
  if (!res.ok || o?.success === false) {
    throw new Error(o?.message ?? o?.errors?.map((e) => e.detail).join(" / ") ?? `\uC2E4\uD328 ${res.status}`);
  }
  return parsed;
}
function \uC544\uBB34\uAE00\uC790(n = 8) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
async function \uB85C\uADF8\uC778\uB410\uB098(page3, check) {
  if (!check?.api) return null;
  return page3.evaluate(async (u) => {
    const r2 = await fetch(u, { credentials: "include" });
    return r2.status;
  }, check.api).then((s) => s === (check.okStatus ?? 200)).catch(() => null);
}
async function \uBC29\uC9C0\uBB38\uC790\uCC44\uC6B0\uAE30(page3, cap) {
  if (!cap?.selectors?.length || cap.how !== "random") return null;
  for (const sel of cap.selectors) {
    const el = page3.locator(sel).first();
    const \uBCF4\uC784 = await el.isVisible().catch(() => false);
    if (!\uBCF4\uC784) continue;
    if (await el.inputValue().catch(() => "x") !== "") continue;
    const \uAC12 = \uC544\uBB34\uAE00\uC790(cap.length ?? 8);
    const r2 = await act(page3, { do: "type", selectors: [sel], value: \uAC12 });
    if (r2.ok) return \uAC12.length;
  }
  return null;
}
async function login(page3, context3, market) {
  const \uD55C\uC77C = [];
  const \uACB0\uACFC = (r2) => ({
    market,
    url: page3.url(),
    \uD55C\uC77C,
    ...r2
  });
  let recipe;
  try {
    recipe = await shopware(`/api/_action/cmh-ai/login/recipe?market=${encodeURIComponent(market)}`, "GET");
  } catch (e) {
    return \uACB0\uACFC({ ok: false, \uB2E8\uACC4: "\uB808\uC2DC\uD53C", \uC774\uC720: e instanceof Error ? e.message : String(e) });
  }
  \uD55C\uC77C.push(`\uB808\uC2DC\uD53C \uBC1B\uC74C (${recipe.platformCode}, \uCC44\uC6B8 \uCE78 ${recipe.fields.length}\uAC1C)`);
  if (recipe.storageState) {
    try {
      const st = JSON.parse(recipe.storageState);
      const now = Date.now() / 1e3;
      const fresh = (st.cookies ?? []).filter((c) => !c.expires || c.expires === -1 || c.expires > now);
      if (fresh.length) {
        await context3.addCookies(fresh);
        \uD55C\uC77C.push(`\uC800\uC7A5\uB41C \uCFE0\uD0A4 ${fresh.length}\uAC1C \uB123\uC74C`);
      }
    } catch {
      \uD55C\uC77C.push("\uC800\uC7A5\uB41C \uCFE0\uD0A4\uAC00 \uAE68\uC838 \uC788\uC5B4 \uAC74\uB108\uB700");
    }
  }
  const \uD648 = recipe.check?.url ?? recipe.baseUrl ?? recipe.loginUrl;
  await page3.goto(\uD648, { waitUntil: "domcontentloaded", timeout: 6e4 }).catch(() => {
  });
  await page3.waitForTimeout(2e3);
  if (await \uB85C\uADF8\uC778\uB410\uB098(page3, recipe.check) === true) {
    \uD55C\uC77C.push("\uC774\uBBF8 \uB85C\uADF8\uC778\uB418\uC5B4 \uC788\uC74C \u2014 \uB85C\uADF8\uC778 \uC548 \uD568");
    return \uACB0\uACFC({ ok: true, \uB2E8\uACC4: "\uCFE0\uD0A4" });
  }
  const loginUrl = recipe.loginUrl.replace("{returnUrl}", encodeURIComponent(\uD648));
  await page3.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 6e4 });
  await page3.waitForTimeout(2e3);
  for (const f of recipe.fields) {
    if (!f.value) {
      return \uACB0\uACFC({ ok: false, \uB2E8\uACC4: "\uC785\uB825", \uC774\uC720: `"${f.key}" \uAC12\uC774 \uD45C\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 \uB123\uC5B4 \uC8FC\uC138\uC694.` });
    }
    const r2 = await act(page3, { do: "type", selectors: f.selectors, value: f.value });
    if (!r2.ok) {
      return \uACB0\uACFC({ ok: false, \uB2E8\uACC4: "\uC785\uB825", \uC774\uC720: `"${f.key}" \uCE78\uC5D0 \uBABB \uB123\uC5C8\uC2B5\uB2C8\uB2E4: ${r2.\uC774\uC720}` });
    }
    \uD55C\uC77C.push(`${f.key} \uB123\uC74C (${f.value.length}\uAE00\uC790)`);
  }
  const \uBC29\uC9C0 = await \uBC29\uC9C0\uBB38\uC790\uCC44\uC6B0\uAE30(page3, recipe.captcha);
  if (\uBC29\uC9C0 !== null) \uD55C\uC77C.push(`\uC790\uB3D9\uC785\uB825 \uBC29\uC9C0 \uBB38\uC790\uC5D0 \uC544\uBB34 \uAE00\uC790 ${\uBC29\uC9C0}\uC790 \uB123\uC74C (\uC774 \uB9C8\uCF13\uC740 \uC774 \uAE00\uC790\uB97C \uC548 \uB9DE\uCDB0 \uBD04)`);
  if (!recipe.submit?.selectors?.length) {
    return \uACB0\uACFC({ ok: false, \uB2E8\uACC4: "\uBCF4\uB0B4\uAE30", \uC774\uC720: "login_flow \uC5D0 submit \uC120\uD0DD\uC790\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
  }
  const sent = await act(page3, { do: "click", selectors: recipe.submit.selectors, text: "\uB85C\uADF8\uC778" });
  if (!sent.ok) {
    return \uACB0\uACFC({ ok: false, \uB2E8\uACC4: "\uBCF4\uB0B4\uAE30", \uC774\uC720: sent.\uC774\uC720 });
  }
  \uD55C\uC77C.push("\uB85C\uADF8\uC778 \uBC84\uD2BC \uB204\uB984");
  await page3.waitForLoadState("networkidle", { timeout: 2e4 }).catch(() => {
  });
  await page3.waitForTimeout(3e3);
  if (await \uB85C\uADF8\uC778\uB410\uB098(page3, recipe.check) !== true) {
    const \uB2E4\uC2DC = await \uBC29\uC9C0\uBB38\uC790\uCC44\uC6B0\uAE30(page3, recipe.captcha);
    if (\uB2E4\uC2DC !== null) {
      \uD55C\uC77C.push(`\uBC29\uC9C0 \uBB38\uC790\uAC00 \uC0C8\uB85C \uB5A0\uC11C \uB2E4\uC2DC ${\uB2E4\uC2DC}\uC790 \uB123\uACE0 \uD55C \uBC88 \uB354 \uBCF4\uB0C4`);
      await act(page3, { do: "click", selectors: recipe.submit.selectors, text: "\uB85C\uADF8\uC778" });
      await page3.waitForLoadState("networkidle", { timeout: 2e4 }).catch(() => {
      });
      await page3.waitForTimeout(3e3);
    }
  }
  const \uB410\uB098 = await \uB85C\uADF8\uC778\uB410\uB098(page3, recipe.check);
  if (\uB410\uB098 !== true) {
    let \uD654\uBA74\uB9D0 = "";
    for (const sel of recipe.error?.selectors ?? []) {
      \uD654\uBA74\uB9D0 = await page3.locator(sel).first().innerText({ timeout: 1e3 }).catch(() => "");
      if (\uD654\uBA74\uB9D0.trim()) break;
    }
    await shopware("/api/_action/cmh-ai/login/result", "POST", {
      market,
      ok: false,
      message: \uD654\uBA74\uB9D0.trim().slice(0, 200) || "\uB85C\uADF8\uC778 \uD655\uC778 \uC2E4\uD328"
    }).catch(() => {
    });
    return \uACB0\uACFC({
      ok: false,
      \uB2E8\uACC4: "\uD655\uC778",
      \uC774\uC720: \uD654\uBA74\uB9D0.trim() || "\uB85C\uADF8\uC778\uC774 \uC548 \uB410\uC2B5\uB2C8\uB2E4(\uB9C8\uCF13 API \uAC00 \uC544\uB2C8\uB77C\uACE0 \uB2F5\uD588\uC2B5\uB2C8\uB2E4).",
      \uC0AC\uB78C\uD544\uC694: recipe.manual?.reason ?? "\uCC3D\uC5D0\uC11C \uC9C1\uC811 \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694."
    });
  }
  const state = JSON.stringify(await context3.storageState());
  await shopware("/api/_action/cmh-ai/login/result", "POST", {
    market,
    ok: true,
    message: "\uB85C\uADF8\uC778 \uC131\uACF5",
    storageState: state
  });
  \uD55C\uC77C.push("\uB85C\uADF8\uC778 \uCFE0\uD0A4\uB97C \uC11C\uBC84\uC5D0 \uC7A0\uAC00\uC11C \uC800\uC7A5");
  return \uACB0\uACFC({ ok: true, \uB2E8\uACC4: "\uD655\uC778" });
}

// src/submit.ts
import fs2 from "node:fs";
import path4 from "node:path";

// src/api.ts
function getPath(obj, path5) {
  let cur = obj;
  for (const key of path5.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (cur === null || cur === void 0) return void 0;
    cur = cur[key];
  }
  return cur;
}
function setPath(obj, path5, value) {
  const keys = path5.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== "object") return false;
    cur = cur[key];
  }
  if (cur === null || typeof cur !== "object") return false;
  cur[keys[keys.length - 1]] = value;
  return true;
}

// src/dump.ts
import path3 from "node:path";
function outDir() {
  return process.env.CAMOUFOX_MCP_OUT ?? path3.resolve(process.cwd(), "inspection");
}
function safeKey(menuKey) {
  const cleaned = menuKey.trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 64);
  if (!cleaned || /^-+$/.test(cleaned)) {
    throw new Error(`menuKey \uAC00 \uC774\uC0C1\uD569\uB2C8\uB2E4: "${menuKey}". \uC601\uBB38\xB7\uC22B\uC790\xB7-\xB7_ \uB9CC \uC4F0\uC138\uC694 (\uC608: product-list)`);
  }
  return cleaned;
}

// src/submit.ts
var WRITE_METHODS2 = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
var MAX_INLINE_BYTES = 8e3;
var MAX_CAUGHT = 5;
function dumpBody(saveAs, index, method, url, body) {
  const dir = outDir();
  fs2.mkdirSync(dir, { recursive: true });
  const file = path4.join(dir, `${safeKey(saveAs)}.request-${index}.json`);
  fs2.writeFileSync(file, JSON.stringify({ method, url, body: safeParse(body) }, null, 2), "utf8");
  return file;
}
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function submit(page3, plan) {
  const caught = [];
  const files = [];
  let \uCCAB\uC694\uCCAD\uC54C\uB9BC = null;
  const \uCCAB\uC694\uCCAD = new Promise((resolve) => {
    \uCCAB\uC694\uCCAD\uC54C\uB9BC = resolve;
  });
  const handler = async (route) => {
    const req = route.request();
    if (!WRITE_METHODS2.has(req.method()) || caught.length >= MAX_CAUGHT) {
      await route.continue().catch(() => {
      });
      return;
    }
    const raw = req.postData() ?? "";
    const bytes = Buffer.byteLength(raw, "utf8");
    const parsed = safeParse(raw);
    const isObj = parsed !== null && typeof parsed === "object";
    const one = {
      method: req.method(),
      url: req.url(),
      bytes,
      \uCC98\uB9AC: plan.mode === "block" ? "\uBC84\uB9BC" : plan.mode === "patch" ? "\uACE0\uCCD0\uC11C \uBCF4\uB0C4" : "\uADF8\uB300\uB85C \uBCF4\uB0C4"
    };
    if (isObj) one.\uB9E8\uC704\uCE78\uC774\uB984 = Object.keys(parsed).slice(0, 40);
    if (bytes <= MAX_INLINE_BYTES) one.\uBCF8\uBB38 = parsed;
    if (plan.saveAs && raw) {
      files.push(dumpBody(plan.saveAs, caught.length + 1, req.method(), req.url(), raw));
    }
    let \uBCF4\uB0BC\uBCF8\uBB38 = raw;
    if (plan.mode === "patch" && plan.set && isObj) {
      const \uBC14\uAFBC\uAC83 = [];
      const \uC5C6\uC74C = [];
      for (const [p, v] of Object.entries(plan.set)) {
        const \uC804 = getPath(parsed, p);
        if (setPath(parsed, p, v)) \uBC14\uAFBC\uAC83.push({ \uACBD\uB85C: p, \uC804, \uD6C4: v });
        else \uC5C6\uC74C.push(p);
      }
      one.\uBC14\uAFBC\uAC83 = \uBC14\uAFBC\uAC83;
      if (\uC5C6\uC74C.length) one.\uACBD\uB85C\uC5C6\uC74C = \uC5C6\uC74C;
      \uBCF4\uB0BC\uBCF8\uBB38 = JSON.stringify(parsed);
    }
    caught.push(one);
    \uCCAB\uC694\uCCAD\uC54C\uB9BC?.();
    if (plan.mode === "block") {
      await route.abort().catch(() => {
      });
      return;
    }
    await route.continue({ postData: \uBCF4\uB0BC\uBCF8\uBB38 }).catch(() => {
    });
  };
  await page3.route(plan.urlPattern, handler);
  let \uB204\uB974\uAE30;
  try {
    \uB204\uB974\uAE30 = await act(page3, plan.click);
    await Promise.race([\uCCAB\uC694\uCCAD, new Promise((r2) => setTimeout(r2, plan.waitMs ?? 15e3))]);
    if (caught.length) await new Promise((r2) => setTimeout(r2, 1500));
  } finally {
    await page3.unroute(plan.urlPattern, handler).catch(() => {
    });
  }
  const \uC548\uB0B4 = caught.length === 0 ? \uB204\uB974\uAE30.ok ? `\uB20C\uB800\uC9C0\uB9CC "${plan.urlPattern}" \uC5D0 \uB9DE\uB294 \uC800\uC7A5 \uC694\uCCAD\uC774 \uC548 \uB098\uAC14\uC2B5\uB2C8\uB2E4. \uBB34\uB2AC\uAC00 \uD2C0\uB838\uAC70\uB098(\uC8FC\uC18C\uB97C browser_network_requests \uB85C \uD655\uC778\uD558\uC138\uC694), \uD654\uBA74\uC774 \uBA3C\uC800 \uB9C9\uC558\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4(\uD544\uC218\uAC12 \uB4F1).` : "\uB204\uB974\uC9C0 \uBABB\uD574\uC11C \uC544\uBB34 \uC694\uCCAD\uB3C4 \uC548 \uB098\uAC14\uC2B5\uB2C8\uB2E4. \uB204\uB974\uAE30 \uACB0\uACFC\uC758 \uC774\uC720\uB97C \uBCF4\uC138\uC694." : plan.mode === "block" ? `\uC694\uCCAD ${caught.length}\uAC74\uC744 \uC7A1\uC544\uC11C **\uBC84\uB838\uC2B5\uB2C8\uB2E4. \uB124\uC774\uBC84\uC5D0\uB294 \uC544\uBB34\uAC83\uB3C4 \uC548 \uAC14\uC2B5\uB2C8\uB2E4.** \uD654\uBA74\uC5D0 \uC800\uC7A5 \uC2E4\uD328 \uC548\uB0B4\uAC00 \uB730 \uC218 \uC788\uB294\uB370, \uADF8\uAC74 \uC6B0\uB9AC\uAC00 \uB9C9\uC558\uAE30 \uB54C\uBB38\uC785\uB2C8\uB2E4 \u2014 \uACE0\uC7A5\uC774 \uC544\uB2D9\uB2C8\uB2E4.` : plan.mode === "patch" ? `\uC694\uCCAD ${caught.length}\uAC74\uC758 \uBCF8\uBB38\uC744 \uACE0\uCCD0\uC11C \uB124\uC774\uBC84\uB85C \uBCF4\uB0C8\uC2B5\uB2C8\uB2E4. **\uC2E4\uC81C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4.**` : `\uC694\uCCAD ${caught.length}\uAC74\uC744 \uADF8\uB300\uB85C \uB124\uC774\uBC84\uB85C \uBCF4\uB0C8\uC2B5\uB2C8\uB2E4. **\uC2E4\uC81C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4.**`;
  return {
    ok: caught.length > 0 && \uB204\uB974\uAE30.ok,
    mode: plan.mode,
    \uB204\uB974\uAE30,
    \uC7A1\uC740\uC694\uCCAD: caught,
    ...files.length ? { \uD30C\uC77C: files } : {},
    \uC548\uB0B4
  };
}

// scripts/learn-naver-save.ts
var \uC0C1\uD488\uBC88\uD638 = process.argv[2] ?? "12405647327";
var \uC8FC\uC18C = `https://sell.smartstore.naver.com/#/products/edit/${\uC0C1\uD488\uBC88\uD638}`;
console.log("\u203B \uC774 \uC2A4\uD06C\uB9BD\uD2B8\uB294 \uC544\uBB34\uAC83\uB3C4 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 (mode: block \u2014 \uC694\uCCAD\uC744 \uC7A1\uC544\uC11C \uBC84\uB9BC)\n");
var { page: page2, context: context2, recorder: recorder2 } = await openBrowser({ blockImages: false });
console.log("\u2460 \uB85C\uADF8\uC778");
var l = await login(page2, context2, "naver_smartstore");
for (const \uC904 of l.\uD55C\uC77C) console.log("   -", \uC904);
if (!l.ok) {
  console.log(`
\u274C \uB85C\uADF8\uC778 \uC2E4\uD328 (${l.\uB2E8\uACC4}\uB2E8\uACC4): ${l.\uC774\uC720}`);
  if (l.\uC0AC\uB78C\uD544\uC694) console.log(`   \uC0AC\uB78C\uC774 \uD560 \uAC83: ${l.\uC0AC\uB78C\uD544\uC694}`);
  await closeBrowser().catch(() => {
  });
  process.exit(1);
}
console.log("   \u2705 \uB85C\uADF8\uC778 \uB428");
console.log("\n\u2461 \uC0C1\uD488\uC218\uC815 \uD654\uBA74 \uC5F4\uAE30:", \uC8FC\uC18C);
await page2.goto(\uC8FC\uC18C, { waitUntil: "domcontentloaded", timeout: 6e4 });
await page2.waitForLoadState("networkidle", { timeout: 3e4 }).catch(() => {
});
await page2.waitForTimeout(4e3);
console.log("   \uC9C0\uAE08 \uC8FC\uC18C:", page2.url());
console.log('\n\u2462 \uD654\uBA74\uC5D0\uC11C "\uC800\uC7A5" \uC774 \uB4E0 \uAC83 \uCC3E\uAE30');
var snap = await snapshot(page2, { find: "\uC800\uC7A5", limit: 12 });
console.log(`   \uD654\uBA74 \uC804\uCCB4 ${snap.totalOnScreen}\uAC1C \uC911 "\uC800\uC7A5" \uC774 \uB4E0 \uAC83 ${snap.elements.length}\uAC1C`);
for (const e of snap.elements) {
  console.log(
    `     ${e.tag}  "${e.name ?? ""}"${e.nth !== void 0 ? `  (\uACB9\uCE68 \uC21C\uBC88 ${e.nth})` : ""}
        ${e.selectors[0]?.strategy}: ${e.selectors[0]?.expression}`
  );
}
recorder2.clear();
console.log("\n\u2463 \uC800\uC7A5 \uB204\uB974\uAE30 \u2014 \uB098\uAC00\uB294 \uC694\uCCAD\uC740 \uC7A1\uC544\uC11C \uBC84\uB9BD\uB2C8\uB2E4");
var r = await submit(page2, {
  // 넓게 겁니다. 어느 주소로 가는지 아직 모르기 때문입니다.
  // GET 은 그냥 통과시키므로 화면이 자료를 읽는 데는 지장이 없습니다.
  urlPattern: "**/api/**",
  mode: "block",
  click: { do: "click", text: "\uC800\uC7A5\uD558\uAE30" },
  saveAs: `naver-product-${\uC0C1\uD488\uBC88\uD638}-save`,
  waitMs: 2e4
});
console.log("\n\u2500\u2500 \uACB0\uACFC \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
console.log("\uB204\uB974\uAE30:", r.\uB204\uB974\uAE30.ok ? `\uC131\uACF5 (${r.\uB204\uB974\uAE30.\uC4F4\uAC83})` : `\uC2E4\uD328 \u2014 ${r.\uB204\uB974\uAE30.\uC774\uC720}`);
console.log("\uC548\uB0B4  :", r.\uC548\uB0B4);
for (const c of r.\uC7A1\uC740\uC694\uCCAD) {
  console.log(`
\u25A0 ${c.method} ${c.url}`);
  console.log(`  \uD06C\uAE30 ${c.bytes.toLocaleString()} \uBC14\uC774\uD2B8 \xB7 \uCC98\uB9AC ${c.\uCC98\uB9AC}`);
  if (c.\uB9E8\uC704\uCE78\uC774\uB984) console.log(`  \uB9E8 \uC704 \uCE78 \uC774\uB984: ${c.\uB9E8\uC704\uCE78\uC774\uB984.join(", ")}`);
  if (c.\uBCF8\uBB38) console.log(`  \uBCF8\uBB38: ${JSON.stringify(c.\uBCF8\uBB38).slice(0, 600)}`);
}
if (r.\uD30C\uC77C?.length) console.log("\n\uBCF8\uBB38\uC744 \uB0A8\uAE34 \uD30C\uC77C:", r.\uD30C\uC77C.join("\n           "));
var \uAE30\uB85D = recorder2.writes();
if (\uAE30\uB85D.length) {
  console.log("\n(\uCC38\uACE0) \uAE30\uB85D\uAE30\uAC00 \uBCF8 \uAC12 \uBC14\uAFB8\uB294 \uC694\uCCAD:");
  for (const w of \uAE30\uB85D) console.log(`  ${w.method} ${w.status} ${w.url}  \uBCF4\uB0B8\uD06C\uAE30 ${w.sentBytes ?? 0}`);
} else {
  console.log("\n(\uCC38\uACE0) \uAE30\uB85D\uAE30\uC5D0 \uC7A1\uD78C \uAC12 \uBC14\uAFB8\uB294 \uC694\uCCAD \uC5C6\uC74C = \uB124\uC774\uBC84\uB85C \uB098\uAC04 \uAC83\uC774 \uC5C6\uB2E4\uB294 \uB73B\uC785\uB2C8\uB2E4.");
}
console.log("\n20\uCD08 \uB4A4 \uCC3D\uC744 \uB2EB\uC2B5\uB2C8\uB2E4 (\uB2EB\uC744 \uB54C \uB85C\uADF8\uC778 \uC0C1\uD0DC\uB97C \uD30C\uC77C\uC5D0 \uC800\uC7A5\uD569\uB2C8\uB2E4).");
await page2.waitForTimeout(2e4);
await closeBrowser().catch(() => {
});
