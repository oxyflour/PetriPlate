import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "mega-brdf",
  description: "WGSL terrain editor with WebGPU quadtree acceleration"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
