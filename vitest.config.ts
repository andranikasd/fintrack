import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/** Wrangler serves .ttf files as Data modules; do the same for the tests. */
export default defineConfig({
  plugins: [
    {
      name: 'ttf-as-arraybuffer',
      enforce: 'pre',
      load(id) {
        const file = id.split('?')[0]!;
        if (!file.endsWith('.ttf')) return null;
        const base64 = readFileSync(file).toString('base64');
        return `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
export default bytes.buffer;`;
      },
    },
  ],
  test: { include: ['tests/**/*.test.ts'] },
});
