import type { Metadata } from "next";
import "./globals.css";
import NavShell from "./nav-shell";

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
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
