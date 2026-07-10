import type { Metadata } from "next";
import { Space_Mono, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import NavShell from "./nav-shell";

const displayFont = Space_Mono({ variable: "--font-display", weight: "700", subsets: ["latin"] });
const bodyFont = IBM_Plex_Sans({ variable: "--font-body", weight: ["400", "500", "600"], subsets: ["latin"] });
const dataFont = IBM_Plex_Mono({ variable: "--font-data", weight: ["400", "500"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Local AI Lab",
  description: "Train, own, and run your own local models.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${bodyFont.variable} ${dataFont.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
