// esbuild.config.js — transpiles the plugin into ESM files.
// Bundle the SDK into the plugin entry so OpenClaw's plugin loader does not
// have to resolve workspace/file dependencies at runtime.

import esbuild from 'esbuild'
import { argv } from 'process'

const watch = argv.includes('--watch')

const ctx = await esbuild.context({
  entryPoints: ['src/index.ts', 'src/file-store.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: 'dist',
  external: ['nodemailer', 'ws'],
  sourcemap: true,
  logLevel: 'info',
})

if (watch) {
  await ctx.watch()
  console.log('[esbuild] watching...')
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
