import type { ReactNode } from "react";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/newsreader/opsz.css";
import "@/styles/globals.css";
import { Shell } from "@/components/shell";

/**
 * Two families, each with a job.
 *
 * Schibsted Grotesk is the interface: a newspaper grotesque that stays
 * readable from a 5rem headline down to a 0.85rem label. Newsreader is the
 * factory's own voice: its questions, its summaries and its playbacks are set
 * in it, so a person can tell at a glance what the factory said from what the
 * page says around it.
 *
 * Both ship in the bundle from npm rather than being fetched from a font host
 * at runtime. The dashboard should not depend on a third party having a good
 * day, and its content security policy would not let it.
 */

export const metadata = {
  title: "Build Your Software Factory",
  description: "Everything the factory is doing, in one place, and everything it needs from you.",
  icons: { icon: "/icon.svg" },
};

// The theme a person chose, applied before the first paint so a dark-mode
// reader is not flashed white on every load.
const THEME = `try{var t=localStorage.getItem("bsf.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
