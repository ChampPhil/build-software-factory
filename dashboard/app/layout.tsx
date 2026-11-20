import type { ReactNode } from "react";
import "@/styles/globals.css";
import { Shell } from "@/components/shell";

export const metadata = {
  title: "Build Software Factory",
  description: "Everything the factory is doing, in one place.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Archivo: an industrial signage grotesque with real tabular figures,
            which every page needs for its number columns. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
