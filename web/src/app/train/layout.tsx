import type { Metadata } from "next";

export const metadata: Metadata = { title: "Training" };

export default function TrainingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
