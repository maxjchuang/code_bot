import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    clearMocks: true,
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
  },
});
