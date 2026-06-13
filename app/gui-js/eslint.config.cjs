const globals = require('globals')

module.exports = [
  {
    files: ['lib/ui/**/*.js', 'renderer.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser }
    },
  },
  {
    files: ['lib/**/*.js', 'cli.js', 'main.js', 'preload.js'],
    ignores: ['lib/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': 'warn',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-useless-escape': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'curly': ['warn', 'multi-line'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-throw-literal': 'error',
      'no-return-await': 'warn',
      'no-path-concat': 'warn',
      'no-new-require': 'error'
    }
  }
]
