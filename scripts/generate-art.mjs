/**
 * Embed the sticker GIFs as data URIs into src/client/art.generated.ts so the
 * published client bundle is fully self-contained (no fs / RPC / remote URLs).
 * Run with `pnpm generate` after replacing any asset.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const assetsDir = resolve(root, 'assets')
const outFile = resolve(root, 'src/client/art.generated.ts')
const versionOut = resolve(root, 'src/client/version.generated.ts')

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const version = typeof pkg.version === 'string' ? pkg.version : '0.0.1'
writeFileSync(
  versionOut,
  [
    '/**',
    ' * Generated current version (from package.json). Do not edit by hand.',
    ' */',
    `export const PET_VERSION = ${JSON.stringify(version)}`,
    '',
  ].join('\n'),
)
console.log(`version.generated.ts written (${version})`)

const names = ['01', '02', '03', '04', '05', '06']
const lines = [
  '/**',
  ' * Generated sticker assets (data URIs). Run `pnpm generate` after replacing any source GIF.',
  ' */',
  'export const PET_GIFS: Record<string, string> = {',
]
for (const name of names) {
  const file = join(assetsDir, `${name}.gif`)
  const bytes = readFileSync(file)
  const b64 = bytes.toString('base64')
  lines.push(`  ${JSON.stringify(name)}: 'data:image/gif;base64,${b64}',`)
}
lines.push('}')

writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`art.generated.ts written (${names.length} gifs, ${readdirSync(assetsDir).filter(f => f.endsWith('.gif')).length} assets)`)
