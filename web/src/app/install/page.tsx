import type { Metadata } from "next";
import InstallApp from "./install-app";
export const metadata: Metadata = { title: "Install app" };
export default function InstallPage() {
  return <InstallApp privateUrl={process.env.LAL_APP_URL || ""} />;
}
