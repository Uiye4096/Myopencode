## 项目创建规则
- 当用户要求创建新脚本、新项目或新建文件时，统一在 ~/Desktop/opencode_temporary/ 下创建子文件夹
- 子文件夹命名格式：YYYY-MM-DD_描述（例如 2026-05-05_backup-script）
- 创建子文件夹后，使用 macOS tag 命令给该子文件夹打上 "Habit" 标签
  - 优先使用 tag --add "Habit" <路径>
  - 若无 tag 命令，使用 xattr 或 osascript 方式打标签

## 下载规则
- 涉及实际文件下载时（如下载图片、PDF、软件包等），使用 ~/Downloads 作为下载目录
- 命令行安装依赖/包（pip install、npm install、brew install 等）不受此规则约束

## Playwright MCP
- Playwright MCP 使用常驻 HTTP server：`http://localhost:8931/mcp`
- Codex、Claude Code、OpenCode 都应连接这个本地 HTTP MCP，不要各自用 `npx @playwright/mcp` 启动独立进程
- 常驻服务使用共享 profile：`/Users/uiye2048/.playwright-mcp/shared-profile`，并启用 `--shared-browser-context`
- 客户端 URL 使用 `http://localhost:8931/mcp`，不要使用 `http://127.0.0.1:8931/mcp`
- 不要为常规 Playwright MCP 任务启用 isolated/临时 profile；只有用户明确要求无痕或干净环境时，才临时启动 isolated MCP
- 遇到登录、验证码、人机检验、2FA、权限授权等无法可靠自动处理的步骤时，放慢操作节奏，说明当前卡点，并请求用户在共享浏览器里手动协助；用户完成后再继续

## 文件搜索规则
- 搜索文件或文件夹时，先对名称做分词/断词处理，使用模糊匹配搜索，不要只搜精确全名
- 例如搜索 "WeChatbot" 时也应尝试 "wechat"、"bot"、"wechat-bot" 等变体

## 文件夹创建规则
- 当需要创建新文件夹时，先问用户要不要加上 macOS Finder 标签（tag），确认后再创建

## 通用协作规则
- 不确定就问，不要猜
- 没有要求的不要写（不做额外改动）
- 只改被要求的部分，不波及无关代码
