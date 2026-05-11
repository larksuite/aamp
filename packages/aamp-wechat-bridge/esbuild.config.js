import esbuild from 'esbuild'
import { argv } from 'node:process'

const watch = argv.includes('--watch')

const ctx = await esbuild.context({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: 'dist',
  external: ['nodemailer', 'ws', 'qrcode-terminal'],
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node',
  },
})

if (watch) {
  await ctx.watch()
  console.log('[esbuild] watching...')
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
