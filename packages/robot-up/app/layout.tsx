import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "robot-up2",
  description: "MuJoCo and Isaac Sim asset router with MJCF preview"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
