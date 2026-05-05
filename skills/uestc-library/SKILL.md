---
name: uestc-library
description: UESTC campus VPN, academic databases (IEEE/Springer/CNKI/ScienceDirect), paper search and PDF download. Use real Chrome profile via CDP to bypass anti-bot detection. Use when user wants to access library resources or download papers.
---

## Delegation Rule — Sisyphus 亲力亲为

Sisyphus **自己直接操作浏览器**，不委托 subagent。

### ⚠️ 先选浏览器方式（二选一，不要混用）

`skill_mcp(mcp_name="playwright")` 和 `playwright-cli` 操作的是**两个不同的浏览器**，混用会导致一边登录了另一边没登。

| | 方式 A: Playwright MCP | 方式 B: playwright-cli + 真实 Chrome |
|---|---|---|
| 命令 | `skill_mcp(mcp_name="playwright", ...)` | `playwright-cli -s=uestc ...` |
| 浏览器来源 | **MCP 自己起一个**（无 profile） | **attach 用户的真实 Chrome**（有 profile） |
| cookie/登录态 | 无，每次都要登录 VPN | 有用户 profile，VPN 登录态可复用 |
| 适用场景 | 测试 / 演示 / 单次 | 生产 / 批量下载 |
| 启动方式 | 无需手动启动 | 必须先在后台启动 Chrome + CDP |

> 🔑 **核心区分**：你用 `skill_mcp` 的时候，不要去启动真实 Chrome，不要去 `playwright-cli attach`。反之亦然。**选一条路，走到底。**

**推荐**：日常使用选方式 A（MCP），简单直接，不需要额外启动 Chrome。

---

## Core Setup

###  真实 Chrome + CDP（批量下载，复用登录态）

**必须先启动真实 Chrome + attach CDP**，否则 headless 会被 IEEE/ScienceDirect 拦截(418)。

```bash
# 1. 启动真实 Chrome（用用户已登录 Google 账号的 profile）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/uiye2048/Library/Application Support/Google/Chrome" \
  --no-first-run &>/dev/null &
sleep 4

# 2. attach playwright-cli 到真实 Chrome
playwright-cli -s=uestc attach --cdp=http://localhost:9222

# 3. 后续操作
playwright-cli -s=uestc goto 'https://webvpn.uestc.edu.cn/'
```

## VPN 登录

### 登录流程（详细步骤，不要跳步）

**第 1 步 - 导航到 VPN 首页**：

```
#  (CLI): playwright-cli -s=uestc goto 'https://webvpn.uestc.edu.cn/'
```

会自动重定向到统一身份认证页。

**第 2 步 - 填登录表单**：
- 用户名输入框：placeholder 含 `student` → 填入 `2024190904025`
  - MCP：`browser_evaluate(function='() => { document.querySelector("input[placeholder*=\"student\"]").value = "2024190904025"; return "ok"; }')`
- 密码输入框：placeholder 含 `Password` → 填入 `UiyeUESTC2048SZX`
  - MCP：同上 evaluate 方式
- 点击 "Login" 链接/按钮

> ⚠️ **注意**：用户名和密码可以用 evaluate().value 赋值，没问题。但 SMS 验证码输入框不行（见下方）。

**第 3 步 - MFA 二次认证**：

登录后会跳转到 `reAuthCheck/reAuthLoginView.do` 页面，步骤：

1. 页面显示 "Multifactor Authorization"，默认选中 **"Wechat scanning code"** 按钮
2. 点击 **"Wechat scanning code"** 按钮（`button "Wechat scanning code"`）→ 展开下拉菜单
3. 下拉菜单出现后，点击 **"SMS"** 链接（`link "SMS"`）
4. 页面切换为 SMS 模式，显示手机号 `180****6804`
5. 点击 **"Obtain"** 按钮（`button "Obtain"`）→ 发送验证码
6. **向用户索要 SMS 验证码**
7. ⚠️ **关键**：SMS 输入框必须用原生 `fill()` 或 `browser_type`，**不能用 `evaluate().value`**！
   ```
   ❌ document.querySelector('input[placeholder="enter"]').value = 'xxxxxx' → 不触发校验，Sign in 会报错
   ✅ page.getByRole('textbox', { name: 'enter' }).fill('xxxxxx') → 正确触发 input 事件
   ```
8. 点击 **"Sign in"** 按钮
9. 登录成功，跳转到 VPN 资源门户

### VPN 登录常见坑

| 坑 | 原因 | 解法 |
|---|---|---|
| SMS 输入后点 Sign in 提示 "Please input dynamic code" | `evaluate().value` 没触发 input 事件，表单校验不通过 | 用 `browser_type` 的 `fill()` |
| 找不到 SMS 选项 | MFA 页面默认显示 Wechat，需要点一下才展开 SMS | 先 click "Wechat scanning code" button |
| 登录按钮点不动 | 页面可能有多个 login form，选错 ref | 用 `getByRole('link', { name: 'Login' })` |

## 数据库访问

### IEEE Xplore（VPN 门户 → IEL 链接）

**第 1 步 - 进入 IEEE**：
- 点击 `ref=e417`（IEL 入口链接）→ 新标签打开 IEEE Xplore

**第 2 步 - 找论文**：
- 搜论文 ID 或关键词 → 点 heading level=3 的第一个结果进入论文详情页

**第 3 步 - 进入 PDF 页**：
- 论文详情页点 "PDF" link → 跳转到 `stamp/stamp.jsp?tp=&arnumber=XXXXX`

**第 4 步 - 下载 PDF**（⚠️ 这是最容易卡住的步骤）：

`stamp/stamp.jsp` 的真相：
```
stamp/stamp.jsp              ← HTML 壳（你看到的只有 <iframe> ref=e2）
  └── <iframe src="stampPDF/getPDF.jsp?tp=&arnumber=XXXXX">  ← 真实 PDF 二进制
```

> `fetch(window.location.href)` 只能拿到 HTML 壳（6KB），不是 PDF。
> Chrome 原生 PDF viewer 的下载按钮在页面 DOM 之外，自动化点不到。

**正确下载流程**（到达 stamp.jsp 后立即执行，不截图、不后退）：

```javascript
// 步骤 A: 从 stamp.jsp 的 <iframe> 拿真实 PDF URL
const pdfUrl = await page.evaluate(() => {
  const iframe = document.querySelector('iframe');
  if (iframe && iframe.src) return iframe.src;
  // 旧版 IEEE 可能用 embed/object
  const embed = document.querySelector('embed[type="application/pdf"]');
  if (embed && embed.src) return embed.src;
  const obj = document.querySelector('object[type="application/pdf"]');
  if (obj && obj.data) return obj.data;
  throw new Error('No PDF source found');
});

// 步骤 B: 直接导航到真实 PDF URL
await page.goto(pdfUrl);  // 浏览器自动渲染 PDF 或触发下载
```

**备选方案**（如果 goto 没自动下载，比如 playwright-cli 环境）：

```bash
# 用 CDP 设置下载行为
playwright-cli -s=uestc cdpsend "Browser.setDownloadBehavior" '{"behavior":"allow","downloadPath":"/Users/uiye2048/Downloads"}'
playwright-cli -s=uestc goto "<iframe_src_url>"
# 或者直接用 curl 下载（VPN 内网 URL 在外部无效，必须在浏览器会话内）
```

### IEEE 下载常见坑

| 坑 | 原因 | 解法 |
|---|---|---|
| `fetch(window.location.href)` 拿到 6KB HTML | stamp.jsp 是壳，不是 PDF | 取 `iframe.src` 再 goto |
| 到 stamp.jsp 看到 PDF 但点不了下载 | Chrome 原生 PDF viewer 下载按钮在 DOM 外 | goto iframe.src 触发浏览器下载 |
| 搜索 embed/object 找不到 | 当前 IEEE 版本用 iframe 不是 embed | 优先查 `iframe` |
| 到达 stamp.jsp 后习惯性截图/后退 | agent 看到空页面想"确认状态" | 强制规则：到 stamp.jsp → 3 步内必须 goto(iframe.src) |

### Springer Nature Link（可直接访问 link.springer.com 无需 VPN）
- 关 cookie 弹窗：`page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()))`
- 搜索框 role=searchbox，论文页找 `a[data-article-pdf]` 链接
- 下载：CDP `Browser.setDownloadBehavior` + 点击

### CNKI（需过滑块验证码时通知用户手动滑一次）

### ScienceDirect（真实 Chrome 下应直接可访问）

## MCP 工具参数速查

> ⚠️ Playwright MCP 工具的参数命名是 `target`，不是 `element`、`ref`、`selector`。

| 操作 | 工具 | 参数 |
|---|---|---|
| 导航 | `browser_navigate` | `url: "..."` |
| 点击 | `browser_click` | `target: "e123"` 或 `target: "button 'Login'"` |
| 输入 | `browser_type` | `target: "e123"` 或 `target: "textbox 'enter'"`, `text: "..."` |
| 截图 | `browser_snapshot` | 无参 或 `snapshot: true` |
| 执行 JS | `browser_evaluate` | `function: "() => { ... }"` |

## 下载路径
所有 PDF 保存到 `/Users/uiye2048/Downloads/`

## 清理
```bash
playwright-cli -s=uestc close
# 或
playwright-cli kill-all
```
