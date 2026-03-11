import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        DOMParser: 'readonly',
        localStorage: 'readonly',
        history: 'readonly',
        location: 'readonly',
        visualViewport: 'readonly',
        performance: 'readonly',
        devicePixelRatio: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        crypto: 'readonly',

        // Vendor libs (loaded via <script> tags, accessed as window.*)
        pdfjsLib: 'readonly',
        PDFLib: 'readonly',
        SignaturePad: 'readonly',
        fontkit: 'readonly',
        gtag: 'readonly',
      },
    },
    rules: {
      // Catch real bugs
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // Relaxed for this codebase's patterns
      'no-case-declarations': 'off',       // Switch cases with let/const are fine
      'no-useless-assignment': 'off',       // Triggers on let-then-reassign pattern
      'preserve-caught-error': 'off',       // Not applicable

      // Style — keep loose, no formatting opinions
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'eqeqeq': ['warn', 'smart'],
    },
  },
  {
    // Ignore vendor libs and generated files
    ignores: [
      'js/vendor/**',
      'node_modules/**',
      'docs/**',
    ],
  },
];
