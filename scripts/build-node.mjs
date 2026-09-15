import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/runtime/main.ts',
    backup: 'src/runtime/backup-cli.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  loader: { '.ttf': 'binary' },
  sourcemap: true,
  logLevel: 'info',
});
