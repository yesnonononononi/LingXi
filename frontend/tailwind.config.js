/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          950: '#030712', // 纯正科技暗黑
        },
        indigo: {
          650: '#4f46e5', // 柔和深 Indigo
        }
      }
    },
  },
  plugins: [],
}
