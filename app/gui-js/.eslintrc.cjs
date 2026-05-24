module.exports = {
  env: {
    node: true,
    es2022: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs'
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
    'no-new-require': 'error',
    'no-sync': 'off',
    'handle-callback-err': 'off'
  },
  overrides: [
    {
      files: ['cli.js', 'main.js', 'preload.js'],
      env: {
        node: true,
        browser: false
      }
    }
  ]
}
