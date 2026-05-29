/**
 * connector-notion.ts — real Notion handlers via raw REST.
 *
 * Auth: Notion integration token (secret_…) stored in vault.
 * Notion requires a `Notion-Version` header — we pin it to the stable
 * 2022-06-28 version. Bump when migrating.
 *
 * Wired actions:
 *   - notion.search          (read)
 *   - notion.read_page       (read)
 *   - notion.create_page     (draft → approval required)
 *   - notion.query_database  (read)
 *
 * `notion.update_page` is declared but not wired — block-by-block
 * patching is involved enough to deserve its own handler when needed.
 */
import type { ConnectorHandler, DryRunFn } from './connectors.js'

const BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

async function call<T>(token: string, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type':   'application/json',
      'authorization':  `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
    },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, init)
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`Notion ${resp.status}: ${txt.slice(0, 300)}`)
  }
  return resp.json() as Promise<T>
}

interface NotionRichText { plain_text: string }
interface NotionPage {
  id: string; created_time: string; last_edited_time: string;
  url: string; archived: boolean;
  properties: Record<string, { type: string; title?: NotionRichText[]; rich_text?: NotionRichText[] }>;
}

export const search: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const query = typeof params['query'] === 'string' ? params['query'] : ''
  const page_size = Math.min(Number(params['page_size'] ?? 25), 100)
  const data = await call<{ results: NotionPage[] }>(token, '/search', {
    query, page_size,
  })
  // Slim shape — pull title from properties (first title-typed prop)
  return data.results.map(p => {
    const titleProp = Object.values(p.properties).find(v => v.type === 'title')
    const title = titleProp?.title?.map(t => t.plain_text).join('') ?? '(untitled)'
    return {
      id:    p.id,
      title,
      url:   p.url,
      createdAt:    p.created_time,
      lastEditedAt: p.last_edited_time,
      archived:     p.archived,
    }
  })
}

export const readPage: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const pageId = String(params['pageId'] ?? params['id'] ?? '').trim()
  if (!pageId) throw new Error('params.pageId required')
  const page = await call<NotionPage>(token, `/pages/${pageId}`, undefined, 'GET')
  const titleProp = Object.values(page.properties).find(v => v.type === 'title')
  return {
    id: page.id,
    title: titleProp?.title?.map(t => t.plain_text).join('') ?? '(untitled)',
    url: page.url,
    createdAt: page.created_time,
    lastEditedAt: page.last_edited_time,
    archived: page.archived,
  }
}

export const createPage: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const parent = params['parent']                  // { database_id } or { page_id }
  const title  = String(params['title'] ?? '').trim()
  if (!parent || (typeof parent !== 'object')) throw new Error('params.parent required ({ database_id } or { page_id })')
  if (title.length < 1) throw new Error('params.title required')

  // Body content as a single paragraph if provided
  const body = typeof params['body'] === 'string' ? params['body'] : null

  const result = await call<{ id: string; url: string }>(token, '/pages', {
    parent,
    properties: {
      // Default property name for databases is usually "Name" or "Title"; if
      // operator passes a different property key, they must pass full
      // `properties` instead of `title`. Keep this convenience for the
      // 90% case.
      Name: { title: [{ text: { content: title } }] },
    },
    ...(body ? {
      children: [{
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: body } }] },
      }],
    } : {}),
  })
  return { id: result.id, url: result.url, title }
}

export const queryDatabase: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const databaseId = String(params['databaseId'] ?? params['id'] ?? '').trim()
  if (!databaseId) throw new Error('params.databaseId required')
  const page_size = Math.min(Number(params['page_size'] ?? 25), 100)
  const filter = params['filter']
  const sorts = params['sorts']

  const data = await call<{ results: NotionPage[] }>(
    token, `/databases/${databaseId}/query`,
    {
      page_size,
      ...(filter ? { filter } : {}),
      ...(sorts  ? { sorts }  : {}),
    },
  )
  return data.results.map(p => {
    const titleProp = Object.values(p.properties).find(v => v.type === 'title')
    return {
      id:    p.id,
      title: titleProp?.title?.map(t => t.plain_text).join('') ?? '(untitled)',
      url:   p.url,
      createdAt:    p.created_time,
      lastEditedAt: p.last_edited_time,
    }
  })
}

export const createPageDryRun: DryRunFn = async (_ctx, params) => {
  const title = String(params['title'] ?? '(no title)')
  const parent = params['parent']
  const parentDesc = parent && typeof parent === 'object'
    ? Object.entries(parent).map(([k, v]) => `${k}=${v}`).join(' ')
    : '(no parent)'
  return { summary: `would create Notion page "${title}" under ${parentDesc}`, affected: { title } }
}
