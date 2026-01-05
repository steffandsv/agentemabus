/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.ejs",
    "./public/**/*.js"
  ],
  theme: {
    extend: {},
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        light: {
          "primary": "#0071e3",
          "secondary": "#FF9500",
          "accent": "#34C759",
          "neutral": "#1D1D1F",
          "base-100": "#FFFFFF",
          "base-200": "#FAFBFC",
          "base-300": "#E8EAED",
          "info": "#0071e3",
          "success": "#34C759",
          "warning": "#FF9500",
          "error": "#FF3B30",
        },
      },
      "dark",
    ],
  },
}
