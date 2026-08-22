import type { Metadata } from "next";

export const metadata: Metadata = { title: "Code" };

export default function CodeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
