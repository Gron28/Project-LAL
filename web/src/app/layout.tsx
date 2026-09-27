import type { Metadata, Viewport } from "next";
import "./globals.css";
import NavShell from "./nav-shell";
import AppRegistration from "./app-registration";
import { TOKENS } from "@/lib/design-tokens";

export const metadata: Metadata = {
  title: {
    default: "LAL — Local AI Lab",
    template: "%s — LAL",
  },
  description: "Measure and improve a local model on your own hardware.",
  applicationName: "LAL",
  manifest: "/manifest.webmanifest?v=lal-logo-5",
  appleWebApp: { capable: true, title: "LAL", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/favicon.ico", sizes: "16x16 32x32 48x48" }, { url: "/app-icons/favicon-32-v5.png", sizes: "32x32", type: "image/png" }, { url: "/app-icons/lal-app.svg?v=5", type: "image/svg+xml" }], apple: "/app-icons/apple-touch-icon-v5.png" },
};

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: TOKENS.bg.canvas,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <AppRegistration />
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
