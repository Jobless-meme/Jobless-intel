import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#FF6B00",
          bright: "#FF8800",
        },
        glow: {
          cyan: "#22D3EE",
          purple: "#7C3AED",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.55", filter: "blur(6px)" },
          "50%": { opacity: "1", filter: "blur(9px)" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(2%,-3%,0) scale(1.05)" },
        },
        cascade: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 2.6s linear infinite",
        breathe: "breathe 3.2s ease-in-out infinite",
        drift: "drift 18s ease-in-out infinite",
        cascade: "cascade 0.4s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
