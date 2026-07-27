# camoufox-mcp

MCP server that drives [Camoufox](https://camoufox.com) (stealth Firefox) through the **real Playwright API** —
headful, humanized, with element-selector extraction and network-JSON capture.
Built for inspecting admin SPAs and automating them without getting flagged.

> 한국어 문서입니다. 아래 내용이 본문입니다.

---

## 무엇을 하는 물건인가

관리자 화면(예: 네이버 스마트스토어 센터)을 **눈에 보이는 창으로 열고**,
그 화면의 **요소 선택자 · 뒤에서 부르는 JSON · 표 구조**를 통째로 뽑아 파일로 남깁니다.

AI(Claude, Copilot 등)가 이 도구를 통해 화면을 직접 보고 조사합니다.

## 왜 직접 만들었나 (`@playwright/mcp` 를 안 쓴 이유)

`@playwright/mcp` 는 브라우저를 자기가 소유합니다. 그러면 이 세 가지를 못 합니다:

1. 사용자가 지금 쓰는 브라우저를 **피해서** 열기
2. 로컬 브라우저의 **쿠키를 복사해 넣기**
3. 지문·humanize 옵션을 **우리가 조절하기**

그래서 Camoufox 를 직접 감쌌습니다.

## 특징

| | |
|---|---|
| **눈에 보임** | `headless: false` 고정. 사람이 옆에서 같이 봅니다 |
| **방해 안 함** | 마우스는 브라우저 안에서만 움직입니다. OS 마우스·키보드를 뺏지 않습니다 |
| **사람처럼** | Camoufox 내장 곡선 마우스 + 글자마다 흔들리는 타이핑 간격 |
| **좌표 안 씀** | 요소마다 `ref`(e1, e2…)를 붙이고 그 ref 로만 클릭·입력합니다 |
| **JSON 그대로** | 화면 글자를 긁지 않고 뒤에서 오가는 원본 JSON 을 받아 적습니다 |
| **로그인 유지** | 프로필 폴더에 남습니다. 한 번 로그인하면 계속 갑니다 |

---

## 요구 사항

- **Node 22 이상** ⚠️
  Node 21 에서는 Camoufox 지문 생성 중 **프로세스가 조용히 죽습니다**
  (Windows 접근 위반, 오류 메시지도 안 남음).
- Windows / macOS / Linux
- 디스크 약 600MB (Camoufox 바이너리 492MB + GeoIP 66MB)

> Windows 에서 `nvm use 22` 를 했는데도 `node -v` 가 안 바뀌면,
> 환경변수 PATH 에 `...\nvm\v21.x.x` 같은 **버전 폴더가 직접 박혀 있는 것**입니다.
> 그 줄을 지우고 `C:\Program Files\nodejs` 만 남기세요.

## 설치

```bash
git clone https://github.com/KrommerGmbH/camoufox-mcp.git
cd camoufox-mcp
pnpm install
node node_modules/camoufox-js/dist/__main__.js fetch   # 브라우저 내려받기 (1회)
pnpm build
pnpm smoke                                             # 동작 확인
```

## VSCode 에 붙이기

`.vscode/mcp.json`:

```jsonc
{
  "servers": {
    "camoufox": {
      "type": "stdio",
      "command": "node",
      "args": ["E:/Kang/project/camoufox-mcp/dist/index.js"],
      "env": {
        "CAMOUFOX_MCP_PROFILE": "E:/Kang/project/camoufox-mcp/.profile/naver",
        "CAMOUFOX_MCP_OUT": "E:/Kang/project/CmhAiAgent/inspection"
      }
    }
  }
}
```

| 환경변수 | 뜻 | 기본값 |
|---|---|---|
| `CAMOUFOX_MCP_PROFILE` | 브라우저 프로필 폴더 (로그인 상태가 여기 남음) | `./.profile/default` |
| `CAMOUFOX_MCP_OUT` | 조사 결과를 저장할 폴더 | `./inspection` |

## 도구 목록

| 도구 | 하는 일 |
|---|---|
| `browser_open` | 창 띄우기. 지금 실행 중인 브라우저도 같이 알려줌 |
| `browser_status` | 상태 보기 |
| `browser_close` | 창 닫기 |
| `cookies_import` | 로컬 브라우저 쿠키 복사 (파이어폭스 ✅ / 크롬 ❌). **도메인 지정 필수** |
| `goto` | 주소 이동 + 화면 뜰 때까지 대기 (**http/https 만**) |
| `wait` | 글자가 뜰 때까지, 또는 시간만큼 대기 |
| `snapshot` | 화면 요소 전부 뽑기 (ref · 선택자 후보 · select 선택지 · 표 머리글) |
| `network_list` | 지금까지 오간 JSON 목록 |
| `network_body` | 그중 하나의 본문 전체 |
| `network_clear` | 기록 비우기 (다음 화면 조사 전에) |
| `click` | ref 로 클릭 |
| `type` | ref 로 입력 (사람처럼) |
| `screenshot` | 화면 사진 |
| `page_dump` | 결과를 `.json` + `.md` 두 벌로 저장 |

### 조사 한 바퀴 예시

```
browser_open  →  goto(로그인 화면)  →  (사람이 직접 로그인)
              →  network_clear
              →  goto(조사할 메뉴)  →  snapshot  →  network_list
              →  page_dump("product-list", "상품관리 > 상품조회/수정")
```

`page_dump` 가 만든 `.md` 맨 아래에는 **"이 화면에서 할 수 있는 일"** 표가 비어 있습니다.
이건 자동으로 못 채웁니다. 사람과 상의해서 직접 적어야 합니다.
안 적으면 나중에 액션 설계를 못 하고 다시 조사하게 됩니다.

---

## 안전장치

AI 가 넘기는 값을 그대로 믿지 않습니다. 세 곳을 막아뒀습니다.

| 어디 | 무엇을 막나 |
|---|---|
| `cookies_import` | **도메인을 반드시 받습니다.** 비워두면 은행·메일까지 브라우저의 모든 로그인 쿠키가 자동화 창으로 딸려옵니다 |
| `page_dump` | 파일 이름에서 `/ \ . :` 를 전부 지웁니다. `../../.ssh/id_rsa` 같은 이름으로 **저장 폴더 밖에 쓰는 것**을 막습니다 |
| `goto` | `http`/`https` 만 엽니다. `file://` 을 열면 이 컴퓨터의 파일을 그대로 읽어 `snapshot`·`screenshot` 으로 빼낼 수 있습니다 |

`pnpm smoke` 가 브라우저를 띄우기 전에 이 세 가지를 먼저 확인합니다.

## 알려진 제약

| 제약 | 이유 | 대안 |
|---|---|---|
| **크롬 쿠키 복사 불가** | 최근 크롬은 App-Bound 암호화라 크롬 자신만 값을 풀 수 있음 | 창에서 한 번 직접 로그인 |
| **`playwright-core` 는 1.61 미만만** | Camoufox 바이너리의 통신 규격이 그 위 버전과 안 맞음 (`Browser.setDefaultViewport` 오류) | `package.json` 에 이미 고정해 둠 |
| **humanize 는 마우스만** | Camoufox 가 커서만 사람처럼 움직임 | 타이핑 간격은 `type` 도구가 직접 넣음 |
| **창이 처음 뜰 때 포커스를 한 번 가져감** | 운영체제 동작 | 그 뒤로는 사용자 입력을 안 건드림 |

## 라이선스

MIT
