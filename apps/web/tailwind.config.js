/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111315",
        paper: "#f6f7f8",
        graphite: "#717981",
        accent: "#3268e8",
      },
      boxShadow: {
        soft: "0 18px 48px rgba(18, 24, 32, 0.06)",
      },
    },
  },
  plugins: [],
};
