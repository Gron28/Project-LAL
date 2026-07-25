import type { Metadata } from "next";
import "./globals.css";
import NavShell from "./nav-shell";

export const metadata: Metadata = {
  title: "LAL",
  description: "Measure and improve a local model on your own hardware.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
