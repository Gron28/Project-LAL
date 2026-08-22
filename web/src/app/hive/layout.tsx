import type { Metadata } from "next";

export const metadata: Metadata = { title: "Hive" };

export default function HiveLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
