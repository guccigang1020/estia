import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated output. Already git-ignored, but ESLint does not read
    // .gitignore, so it was linting the coverage reporter's own bundled
    // scripts and warning about code nobody here wrote.
    'coverage/**',
    // Agent worktrees are full copies of src/ living inside the repository.
    // Linting them reports every finding twice and blames the wrong file.
    '.claude/worktrees/**',
    // The demo server's build output. `scripts/demo.mjs` points Next at
    // `.next-demo` so a demo run cannot collide with `npm run dev`, and the
    // directory is git-ignored for exactly the reason `.next` is — but ESLint
    // does not read .gitignore, so the moment anybody runs the demo the gate
    // turns red with hundreds of errors inside Turbopack's own bundles.
    '.next-demo/**',
    // The frozen legacy product, kept verbatim as reference. Not ours to
    // lint, and it must never be reformatted.
    '_reference/**',
  ]),
])

export default eslintConfig
