module.exports = {
  content: ['../app/Views/**/*.html', '../public/js/**/*.js'],
  theme: {
    extend: {
      colors: { ink: '#070b16', panel: '#0f1629', panel2: '#151e36', line: '#243051', gold: '#e6b84f', teal: '#2dd4bf', danger: '#f87171' },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
    },
  },
  plugins: [],
};
