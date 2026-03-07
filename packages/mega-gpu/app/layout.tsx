import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "mega-gpu",
  description: "Metal plate IBL and footprint prototype in WebGPU"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
