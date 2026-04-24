import { MAX_MESSAGE_LENGTH } from './config.js'

export function formatForTelegram(text: string): string {
  if (!text) return ''

  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  let work = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(code)
    return `CB${idx}`
  })

  work = work.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(code)
    return `IC${idx}`
  })

  work = work.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  work = work
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^\n_]+)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^\n*]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^\n_]+)_/g, '$1<i>$2</i>')
    .replace(/~~([^\n~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^\s*[-*+]\s+\[ \]\s+/gm, '☐ ')
    .replace(/^\s*[-*+]\s+\[[xX]\]\s+/gm, '☑ ')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^-{3,}$/gm, '')
    .replace(/^\*{3,}$/gm, '')

  // eslint-disable-next-line no-control-regex
  work = work.replace(/IC(\d+)/g, (_m, idx) => {
    const code = inlineCodes[Number(idx)] ?? ''
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<code>${escaped}</code>`
  })
  // eslint-disable-next-line no-control-regex
  work = work.replace(/CB(\d+)/g, (_m, idx) => {
    const code = codeBlocks[Number(idx)] ?? ''
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre>${escaped}</pre>`
  })

  work = work.replace(/\n{3,}/g, '\n\n')
  return work.trim()
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit)
    if (cut < 0) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^\s+/, '')
  }
  if (remaining.length) chunks.push(remaining)
  return chunks
}

export interface ChangelogEntry {
  version: string
  date: string
  bullets: string[]
}

export function parseChangelog(content: string, limit = 2): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null

  for (const line of content.split('\n')) {
    const header = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+?)\s*$/)
    if (header) {
      if (current) entries.push(current)
      if (entries.length >= limit) return entries
      current = { version: header[1], date: header[2], bullets: [] }
      continue
    }
    if (current && line.startsWith('- ')) {
      current.bullets.push(line.slice(2).replace(/`/g, '').trim())
    }
  }
  if (current && entries.length < limit) entries.push(current)
  return entries
}
