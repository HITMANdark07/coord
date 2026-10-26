import type { ReadTaskStatus } from "@coord/protocol";

// Shared by desktop (CSS-in-JS / CSS vars) and mobile (StyleSheet). Plain values only.
export const colors = {
  light: {
    bg: "#ffffff",
    surface: "#f5f5f4",
    text: "#1c1917",
    muted: "#78716c",
    border: "#e7e5e4",
    accent: "#4f46e5",
  },
  dark: {
    bg: "#0c0a09",
    surface: "#1c1917",
    text: "#fafaf9",
    muted: "#a8a29e",
    border: "#292524",
    accent: "#818cf8",
  },
} as const;

export const statusColors: Record<ReadTaskStatus, string> = {
  queued: "#a8a29e",
  setting_up: "#60a5fa",
  running: "#3b82f6",
  needs_input: "#f59e0b",
  review: "#8b5cf6",
  checking: "#06b6d4",
  pr_open: "#6366f1",
  merged: "#10b981",
  closed: "#78716c",
  failed: "#ef4444",
  interrupted: "#f97316",
  cancelled: "#a8a29e",
  cleaned_up: "#78716c",
  unknown: "#a8a29e",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 8, lg: 12 } as const;
export const fontSize = { sm: 12, md: 14, lg: 16, xl: 20, xxl: 28 } as const;
