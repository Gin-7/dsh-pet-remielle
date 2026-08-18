/**
 * Build the browser client bundle: wrap src/client.core.js in the web
 * shell's module loader. Sticker GIFs are NOT inlined anymore — the host
 * serves them at /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif so
 * pets can be added at runtime without rebuilding (see src/pets.js).
 *
 * Run with: node scripts/build-client.mjs  (or `pnpm build:client`)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const coreFile = resolve(root, 'src', 'client.core.js')
const outFile = resolve(root, 'lib', 'client.js')
const pluginId = 'dsh-pet-remielle'

const core = readFileSync(coreFile, 'utf8')
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {
const module = { exports: {} }
const exports = module.exports
`
const footer = 'return module.exports\n} })'

const output = `${banner}${core}\n${footer}\n`
writeFileSync(outFile, output)
console.log(`lib/client.js written (${Math.round(Buffer.byteLength(output) / 1024)} KiB)`)
