---
name: server-infra
description: Infrastructure for self-hosted services on Tencent Cloud. Use when deploying, configuring, or troubleshooting server-side tools (crawl4ai MCP, Firecrawl, etc.).
---

# Server Infrastructure

## Tencent Cloud

- **IP**: 1.14.94.240
- **Hostname**: VM-0-5-ubuntu
- **User**: ubuntu
- **Auth**: `ssh -i ~/Desktop/系统配置/SZX_ssh.pem ubuntu@1.14.94.240`
- **PEM key**: `~/Desktop/系统配置/SZX_ssh.pem`
- **OS**: Ubuntu 22.04.5 LTS
- **Arch**: x86_64

### Installed Tools

- **Google Chrome**: 147.0.7727.137 (`/usr/bin/google-chrome`)
- **Docker**: 29.4.2 (Docker Hub blocked from CN)
- **Node.js**: 22.14.0 (`/usr/local/bin/node`)
- **Redis**: 6.0.16 (running)
- **Python**: 3.10 + crawl4ai 0.8.6
- **MCP SDK**: Python `mcp` v1.27.0 + `fastmcp`

## Services

| Service | Status | Port | Transport | MCP URL |
|---------|--------|------|-----------|---------|
| crawl4ai MCP | active (systemd) | 8100 | sse | `http://1.14.94.240:8100/sse` |
| ticktick MCP | active (systemd) | 8090 | streamable-http | `http://1.14.94.240:8090/mcp` |
| cloudflared tunnel | active (systemd) | 20241 (local) | proxy | tunnels localhost:8090 → public URL |

### TickTick MCP Server

22 tools for TickTick task management:
- `search_tasks`, `create_task`, `update_task`, `delete_task`, `complete_task`
- `filter_tasks`, `move_task`, `batch_update_tasks`, `upsert_task_by_title`
- `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project`
- `weekly_review`, `reschedule_task`, `get_schedule`, `get_task_by_id`
- `set_parent_task`, `unset_parent_task`, `get_subtasks`
- `memory(action, category, key, value)` — read/write user preferences

Server name: `ticktick-task-scheduler`  
Code: `/home/ubuntu/ticktick/mcp_server_remote.py`  
Service: `ticktick-mcp.service`

### crawl4ai MCP Server

Runs as systemd service `crawl4ai-mcp`. Provides two tools:
- `web_scrape(url, max_content_length)` — scrape URL to clean markdown
- `web_search(query, max_results)` — Google search with content

Code: `/opt/firecrawl/mcp_crawl.py`  
Service: `/etc/systemd/system/crawl4ai-mcp.service`

### Connection

```bash
ssh -i ~/Desktop/系统配置/SZX_ssh.pem ubuntu@1.14.94.240
```

### Local MCP Config (opencode.json)

```json
{
  "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp@latest", "--browser", "chrome"] },
  "crawl4ai":  { "type": "remote", "url": "http://1.14.94.240:8100/sse" },
  "ticktick":  { "type": "remote", "url": "http://1.14.94.240:8090/mcp" }
}
```
