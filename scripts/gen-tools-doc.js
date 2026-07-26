#!/usr/bin/env node
// Auto-generates docs/tools.md by statically parsing src/mcp.js.
// Run via: npm run docs:generate
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
const SRC  = join(ROOT, 'src', 'mcp.js')
const OUT  = join(ROOT, 'docs', 'tools.md')

const src = readFileSync(SRC, 'utf8')

// ── Well-known constant params ─────────────────────────────────────────────

const KNOWN = {
  sql:     { type: 'string', req: true,  desc: 'SQL text.' },
  dialect: { type: 'string', req: false, desc: 'SQL dialect (default `"snowflake"`).' },
}

const SCHEMA_OPTS = {
  schema_json: { type: 'string', req: false, desc: 'Inline schema as JSON. Overrides dbt auto-resolution.' },
  schema_yaml: { type: 'string', req: false, desc: 'Inline schema as YAML. Overrides dbt auto-resolution.' },
  project_dir: { type: 'string', req: false, desc: 'dbt project directory (defaults to the resolved project).' },
}

// ── Parse helpers ──────────────────────────────────────────────────────────

// Both scanners below walk JS source counting delimiters, so both must skip over
// spans where a delimiter isn't structural: strings, comments, and REGEX
// LITERALS. Regex literals are the subtle one — `s.replace(/'/g, "''")` in
// mcp.js contains a lone apostrophe that a naive scanner reads as a string
// opener, after which every brace is swallowed and the parse yields nothing.

// A `/` begins a regex (not division) when the previous significant character
// can't end an expression.
const REGEX_ALLOWED_AFTER = '([{,;:=!&|?+-*%~^<>'

/**
 * If a non-code span (string / comment / regex literal) starts at `i`, return
 * `{ end, comment }` where `end` is the index just past it. Otherwise null.
 */
function endOfNonCode(text, i, prevSignificant) {
  const ch = text[i], next = text[i + 1]

  // Comments are transparent: they don't change what token precedes the next
  // `/`, so callers keep their existing `prev` (see COMMENT marker on the return).
  if (ch === '/' && next === '/') {
    const nl = text.indexOf('\n', i)
    return { end: nl === -1 ? text.length : nl, comment: true }
  }
  if (ch === '/' && next === '*') {
    const close = text.indexOf('*/', i + 2)
    return { end: close === -1 ? text.length : close + 2, comment: true }
  }
  if (ch === '/' && (prevSignificant === '' || REGEX_ALLOWED_AFTER.includes(prevSignificant))) {
    let inClass = false
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j]
      if (c === '\\') { j++; continue }
      if (c === '\n') break // an unterminated regex isn't one — fall through
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        while (j + 1 < text.length && /[a-z]/i.test(text[j + 1])) j++ // flags
        return { end: j + 1, comment: false }
      }
    }
    return null
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j]
      if (c === '\\') { j++; continue }
      if (c === ch) return { end: j + 1, comment: false }
    }
    return { end: text.length, comment: false }
  }
  return null
}

/** Return the content between the `{` at openIdx and its matching `}`, plus the closeIdx. */
function matchBraces(text, openIdx) {
  let depth = 0, prev = ''
  for (let i = openIdx; i < text.length; i++) {
    const skip = endOfNonCode(text, i, prev)
    if (skip) { i = skip.end - 1; if (!skip.comment) prev = 'x'; continue }
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { if (--depth === 0) return { content: text.slice(openIdx + 1, i), closeIdx: i } }
    if (!/\s/.test(ch)) prev = ch
  }
  return { content: '', closeIdx: openIdx }
}

/** Split comma-separated entries, respecting nested brackets/parens/braces/strings. */
function splitEntries(text) {
  const parts = [], stack = []
  let start = 0, prev = ''
  for (let i = 0; i < text.length; i++) {
    const skip = endOfNonCode(text, i, prev)
    if (skip) { i = skip.end - 1; if (!skip.comment) prev = 'x'; continue }
    const ch = text[i]
    if ('([{'.includes(ch)) stack.push(ch)
    else if (')]}'.includes(ch)) stack.pop()
    else if (ch === ',' && stack.length === 0) {
      const s = text.slice(start, i).trim()
      if (s) parts.push(s)
      start = i + 1
    }
    if (!/\s/.test(ch)) prev = ch
  }
  const tail = text.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

/** Parse a Zod expression string into `{ type, req, desc }`. */
function parseZod(expr) {
  const optional = expr.includes('.optional()')
  const descM = expr.match(/\.describe\(["'`]([\s\S]*?)["'`]\)/)
  const desc = descM ? descM[1] : ''

  let type = 'any'
  if      (/^z\.string\b/.test(expr))         type = 'string'
  else if (/^z\.number\b/.test(expr))         type = 'number'
  else if (/^z\.boolean\b/.test(expr))        type = 'boolean'
  else if (/^z\.array\(z\.string/.test(expr)) type = 'string[]'
  else if (/^z\.array\(z\.number/.test(expr)) type = 'number[]'
  else if (/^z\.enum\(/.test(expr)) {
    const m = expr.match(/z\.enum\(\[([^\]]+)\]\)/)
    if (m) {
      const vals = m[1].match(/["'][^"']+["']/g) ?? []
      type = vals.map(v => v.slice(1, -1)).map(v => `"${v}"`).join(' | ')
    } else type = 'enum'
  }

  return { type, req: !optional, desc }
}

/** Parse a shape `{ ... }` body text into `{ paramName: { type, req, desc } }`. */
function parseShape(shapeText) {
  const params = {}

  if (shapeText.includes('...SCHEMA_OPTS')) Object.assign(params, SCHEMA_OPTS)

  const cleaned = shapeText
    .replace(/\.\.\.\w+,?\s*/g, '')
    .replace(/\n[ \t]*/g, ' ')

  for (const entry of splitEntries(cleaned)) {
    const ci = entry.indexOf(':')
    if (ci === -1) {
      const k = entry.trim()
      if (KNOWN[k]) params[k] = { ...KNOWN[k] }
      continue
    }
    const k = entry.slice(0, ci).trim()
    const v = entry.slice(ci + 1).trim()
    if (!k || k.startsWith('//')) continue

    if (v === 'sql' || v === 'dialect') {
      params[k] = { ...KNOWN[v] }
    } else if (v.startsWith('z.')) {
      params[k] = parseZod(v)
    }
  }

  return params
}

// ── Extract TOOLS body from source ─────────────────────────────────────────

const toolsObjStart = src.indexOf('const TOOLS = {')
if (toolsObjStart === -1) throw new Error('TOOLS object not found in mcp.js')
const { content: toolsBody } = matchBraces(src, src.indexOf('{', toolsObjStart))

// ── Build ordered event list (categories + tool entries) ───────────────────

const events = []

for (const m of toolsBody.matchAll(/\/\/ ── (.+?) ─+/g)) {
  const name = m[1].replace(/\s*\([^)]*\)/g, '').trim()
  events.push({ pos: m.index, kind: 'cat', name })
}

for (const m of toolsBody.matchAll(/^ {2}(\w+): \{/gm)) {
  events.push({ pos: m.index, kind: 'tool', name: m[1], bracePos: m.index + m[0].length - 1 })
}

events.sort((a, b) => a.pos - b.pos)

// ── Parse each tool ────────────────────────────────────────────────────────

let currentCat = 'General'
const tools = []

for (const ev of events) {
  if (ev.kind === 'cat') { currentCat = ev.name; continue }

  const { content: body } = matchBraces(toolsBody, ev.bracePos)

  const descM = body.match(/description: "((?:[^"\\]|\\.)*)"/)
  const description = descM ? descM[1].replace(/\\"/g, '"') : ''

  let params = {}
  const shapeIdx = body.indexOf('shape:')
  if (shapeIdx !== -1) {
    const shapeOpen = body.indexOf('{', shapeIdx)
    if (shapeOpen !== -1) {
      const { content: shapeText } = matchBraces(body, shapeOpen)
      params = parseShape(shapeText)
    }
  }

  tools.push({ name: ev.name, description, category: currentCat, params })
}

// ── Render markdown ────────────────────────────────────────────────────────

const byCategory = {}
for (const t of tools) (byCategory[t.category] ??= []).push(t)

const anchor = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const lines = [
  '# MCP Tools Reference',
  '',
  '> Auto-generated from `src/mcp.js`. Run `npm run docs:generate` to update.',
  '',
  `opende exposes **${tools.length} deterministic tools** to Claude Code as \`mcp__opende__<tool_name>\`.`,
  '',
  '## Contents',
  '',
  ...Object.entries(byCategory).map(([cat, ts]) =>
    `- [${cat}](#${anchor(cat)}) — ${ts.length} tool${ts.length > 1 ? 's' : ''}`
  ),
  '',
  '---',
  '',
]

for (const [cat, catTools] of Object.entries(byCategory)) {
  lines.push(`## ${cat}`, '')
  for (const t of catTools) {
    lines.push(`### \`${t.name}\``, '', t.description, '')
    const params = Object.entries(t.params)
    if (params.length > 0) {
      lines.push(
        '| Parameter | Type | Required | Description |',
        '|-----------|------|:--------:|-------------|',
        ...params.map(([p, m]) =>
          `| \`${p}\` | \`${m.type}\` | ${m.req ? 'yes' : 'no'} | ${m.desc || '—'} |`
        ),
        '',
      )
    } else {
      lines.push('_No parameters._', '')
    }
  }
}

// ── Write ──────────────────────────────────────────────────────────────────

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`Generated docs/tools.md — ${tools.length} tools in ${Object.keys(byCategory).length} categories`)
