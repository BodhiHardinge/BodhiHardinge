import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: 'index.html', game: 'game.html' } },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
