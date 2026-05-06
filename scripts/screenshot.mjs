#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/screenshot.mjs              — screenshot all routes
 *   node scripts/screenshot.mjs calls        — screenshot a specific route
 *   BASE_URL=http://localhost:3001 node scripts/screenshot.mjs
 *
 * Saves PNG files to screenshots/<name>.png
 * Dashboard dev server must already be running (npm run dev inside dashboard/).
 */

import { execSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'screenshots')
const BASE = process.env.BASE_URL ?? 'http://localhost:3001'

const ROUTES = [
  { name: 'overview',     path: '/' },
  { name: 'calls',        path: '/calls' },
  { name: 'call-detail',  path: '/calls/00000000-0000-0000-0000-000000000000' },
  { name: 'settings',     path: '/settings' },
]

mkdirSync(OUT_DIR, { recursive: true })

const filter = process.argv[2]
const targets = filter ? ROUTES.filter(r => r.name === filter) : ROUTES

if (targets.length === 0) {
  console.error(`Route "${filter}" not found. Available: ${ROUTES.map(r => r.name).join(', ')}`)
  process.exit(1)
}

let failed = false

for (const { name, path } of targets) {
  const url = `${BASE}${path}`
  const file = join(OUT_DIR, `${name}.png`)
  process.stdout.write(`  ${name.padEnd(16)} ${url} ... `)
  try {
    execSync(
      `npx playwright screenshot --channel chrome --viewport-size "1440, 900" --wait-for-timeout 1500 "${url}" "${file}"`,
      { stdio: 'pipe', cwd: ROOT }
    )
    console.log(`saved`)
  } catch (err) {
    console.log(`FAILED`)
    console.error(err.stderr?.toString().trim() || err.message)
    failed = true
  }
}

if (failed) process.exit(1)
