import axios from 'axios';
import { Client } from '@notionhq/client';
import dotenv from 'dotenv';

// 显式加载 .env 文件
dotenv.config();

console.log(process.env.TEST_VARIABLE);  // 如果输出 "hello"，表示 .env 文件加载成功

// 环境变量
const READWISE_TOKEN = process.env.READWISE_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// 检查环境变量是否存在
if (!READWISE_TOKEN || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
  console.error('[配置错误] 请设置环境变量: READWISE_TOKEN, NOTION_TOKEN, NOTION_DATABASE_ID');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// 小工具: 延时
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 归一化 Readwise 高亮数据为一个简单对象（包含 tags 和 url）
function normalizeHighlights(results) {
  const highlights = [];
  for (const book of results || []) {
    const meta = {
      book_title: book?.title || '',
      book_author: book?.author || '',
      source_url: book?.source_url || '',
      category: book?.category || '', // books, articles, tweets, etc.
    };
    for (const h of book?.highlights || []) {
      const rawTags = Array.isArray(h.tags) ? h.tags : [];
      const tags = rawTags
        .map((t) =>
          typeof t === 'string' ? t : (typeof t?.name === 'string' ? t.name : '')
        )
        .filter(Boolean);
      highlights.push({
        id: String(h.id),
        text: h.text || '',
        note: h.note || '',
        location: h.location ?? null,
        highlighted_at: h.highlighted_at || h.created_at || null,
        url: h.url || meta.source_url || '',
        tags,
        ...meta,
      });
    }
  }
  return highlights;
}

// 读取一页 Readwise 导出数据
async function fetchReadwisePage(pageCursor = null) {
  const url = 'https://readwise.io/api/v2/export/';
  const params = {};
  if (pageCursor) params.pageCursor = pageCursor;
  // 如果需要增量同步，可使用 updatedAfter: new Date().toISOString()
  const resp = await axios.get(url, {
    headers: { Authorization: `Token ${READWISE_TOKEN}` },
    params,
    timeout: 30000,
  });
  return resp.data; // { results: [...], nextPageCursor: '...' }
}

// 在 Notion 数据库中查询是否已存在该 URL（按 URL 去重）
async function findPageByUrl(url) {
  const resp = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: 1,
    filter: {
      property: 'URL',
      url: { equals: url },
    },
  });
  return resp.results?.[0] || null;
}

// 将 URL 作为唯一键：存在则更新 Tags，不存在则创建
async function upsertUrlWithTags(h) {
  const url = (h.url || '').trim();
  if (!url) return false; // 没有URL则跳过

  const tags = Array.isArray(h.tags) ? h.tags.filter(Boolean) : [];
  if (!tags.length) return false; // 没有标签则跳过

  const existing = await findPageByUrl(url);

  const titleText = h.book_title?.trim() || url;
  const baseProperties = {
    Title: { title: [{ type: 'text', text: { content: titleText } }] },
    URL: { url },
    Source: h.category
      ? { rich_text: [{ type: 'text', text: { content: h.category } }] }
      : undefined,
    Book: h.book_title
      ? { rich_text: [{ type: 'text', text: { content: h.book_title } }] }
      : undefined,
    Author: h.book_author
      ? { rich_text: [{ type: 'text', text: { content: h.book_author } }] }
      : undefined,
  };

  const toMultiSelect = (list) => list.map((name) => ({ name }));

  if (existing) {
    // 合并现有 Tags 与新 Tags
    const existingTags = existing.properties?.Tags?.multi_select?.map((t) => t.name) || [];
    const merged = Array.from(new Set([...existingTags, ...tags]));
    // 仅当发生变化时更新
    const needUpdate = merged.length !== existingTags.length || merged.some((t, i) => t !== existingTags[i]);
    if (needUpdate) {
      await notion.pages.update({
        page_id: existing.id,
        properties: {
          ...baseProperties,
          Tags: { multi_select: toMultiSelect(merged) },
        },
      });
    }
    return false; // 未新增页面
  } else {
    // 新建页面
    const resp = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        ...baseProperties,
        Tags: { multi_select: toMultiSelect(tags) },
      },
    });
    return !!resp?.id;
  }
}

async function main() {
  console.log('开始从 Readwise 同步 URL+标签 到 Notion...');
  let cursor = null;
  let totalFetched = 0;
  let totalCreated = 0;

  while (true) {
    const page = await fetchReadwisePage(cursor);
    const normalized = normalizeHighlights(page.results);
    totalFetched += normalized.length;

    for (const h of normalized) {
      const created = await upsertUrlWithTags(h);
      if (created) totalCreated += 1;
      await sleep(150); // 简单限速，避免触发速率限制
    }

    if (!page.nextPageCursor) break;
    cursor = page.nextPageCursor;
  }

  console.log(`同步完成。处理高亮: ${totalFetched}, 新增URL页面: ${totalCreated}`);
}

main().catch((err) => {
  console.error('同步失败:', err?.response?.data || err);
  process.exit(1);
});
