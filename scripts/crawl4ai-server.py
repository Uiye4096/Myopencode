#!/usr/bin/env python3
"""Crawl4AI MCP Server - local deployment on Mac, uses system Chrome."""
import sys
from mcp.server.fastmcp import FastMCP
from crawl4ai import AsyncWebCrawler, BrowserConfig

mcp = FastMCP("crawl4ai-local")
BROWSER_CONFIG = BrowserConfig(chrome_channel="chrome", verbose=False)


@mcp.tool()
async def web_scrape(url: str, max_content_length: int = 50000) -> str:
    """Scrape any URL and return clean markdown content."""
    async with AsyncWebCrawler(config=BROWSER_CONFIG) as crawler:
        result = await crawler.arun(url=url)
        return result.markdown[:max_content_length] if result.success else f"Error: {result.error_message}"


@mcp.tool()
async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web and return results from Google."""
    q = query.replace(" ", "+")
    async with AsyncWebCrawler(config=BROWSER_CONFIG) as crawler:
        result = await crawler.arun(
            url=f"https://www.google.com/search?q={q}&num={max_results}"
        )
        return result.markdown[:30000] if result.success else f"Search failed: {result.error_message}"


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "sse"
    mcp.run(transport=mode)
