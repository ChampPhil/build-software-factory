import type { ReactNode } from "react";
import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@/styles/globals.css";
import { Shell } from "@/components/shell";

/**
 * Two families, clearly distinct, each with a job.
 *
 * Archivo is an industrial signage grotesque with a width axis — it holds up
 * at 32px as a heading and at 12px in a rail without turning into a different
 * typeface. IBM Plex Mono carries the numbers, and in this product almost
 * everything is a number: a duration, a cost, a count, a SHA, a run id. That
 * is the opposite of using mono to decorate small labels; here it is the
 * content.
 *
 * Both ship in the bundle from npm rather than being fetched from
 * fonts.googleapis.com at runtime. The dashboard should not depend on a third
 * party having a good day — a lesson this project learned expensively, from a
 * sandbox whose app front-loaded its library from a CDN and rendered blank
 * for a week while every screenshot it produced showed nothing.
 */

export const metadata = {
  title: "Build Software Factory",
  description: "Everything the factory is doing, in one place.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
