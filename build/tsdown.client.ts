/**
 * Build preset for dsh-pet-remielle (original, standalone).
 *
 * Produces two artifacts:
 *   lib/index.js   — host loader entry (ESM; the host half is a no-op apply)
 *   lib/client.js  — browser client bundle (CJS), wrapped for the web shell's
 *                    module loader: window.__ModuleLoader__.load({ id, factory })
 *
 * The client is fully self-contained: sticker assets are inlined as data URIs
 * (src/client/art.generated.ts) and no platform module is imported at runtime,
 * so nothing is marked external — rolldown bundles the whole entry.
 */
import type { UserConfig } from 'tsdown'

const PKG = 'dsh-pet-remielle'

/** Host half: a plain ESM module that exports `apply`. */
export function hostConfig(id: string = PKG): UserConfig {
  return {
    name: id,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
}

/** Client half: a self-contained CJS bundle handed to the web shell's loader. */
export function clientConfig(id: string = PKG): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
