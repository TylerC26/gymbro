import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Space_Grotesk } from "next/font/google";
import "./globals.css";

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-hanken",
  display: "swap",
});

const space = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Gym Tracker",
  description:
    "A minimal gym tracker — plan your day, log your sets, watch your lifts climb, and ask the AI coach.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale — pinch-zoom stays available; locking it out fails WCAG 1.4.4.
  viewportFit: "cover", // lets env(safe-area-inset-*) resolve on notched devices
  themeColor: "#faf9f6",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${hanken.variable} ${space.variable}`}>
      <body>{children}</body>
    </html>
  );
}
