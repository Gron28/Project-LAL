// Guardian carries an owner session and changes independently of the rest of
// the app.  Never let a proxy or an already-open device hold a static page
// across a deployment; stale RSC/chunk pairs present as a generic load error.
export const dynamic = "force-dynamic";

export default function GuardianLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
