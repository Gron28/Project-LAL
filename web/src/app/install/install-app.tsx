"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
export default function InstallApp({ privateUrl }: { privateUrl: string }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [address, setAddress] = useState(privateUrl);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const media = matchMedia("(display-mode: standalone)");
    // Initial reads happen off the effect's synchronous pass (react-hooks lint).
    const first = setTimeout(() => { if (!privateUrl) setAddress(location.origin); restore(); update(); }, 0);
    const update = () => setInstalled(media.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const restore = () => setPrompt((window as Window & { lalInstallPrompt?: InstallPrompt }).lalInstallPrompt || null);
    window.addEventListener("lal-install-available", restore);
    media.addEventListener("change", update);
    const offer = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", offer); window.addEventListener("appinstalled", done);
    return () => { clearTimeout(first); window.removeEventListener("lal-install-available", restore); media.removeEventListener("change", update); window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", done); };
  }, [privateUrl]);
  async function install() {
    if (!prompt) return;
    try { await prompt.prompt(); const choice = await prompt.userChoice; delete (window as Window & { lalInstallPrompt?: InstallPrompt }).lalInstallPrompt; setPrompt(null);
      setMessage(choice.outcome === "accepted" ? "Installation accepted. Your browser will finish creating the app." : "You can install later from your browser menu.");
    } catch { setMessage("Use your browser menu to install LAL."); }
  }
  return <main id="main-content" className="mx-auto max-w-3xl px-5 py-8 pb-28 md:px-8 md:py-12">
    <div className="flex items-center gap-4"><img src="/app-icons/icon-192-v5.png" width={64} height={64} alt="" className="rounded-xl" />
      <div><h1 className="text-2xl font-semibold">Your lab, on both devices</h1><p className="mt-1 text-sm text-[var(--text-2)]">One computer. One dataset library. The same experiments.</p></div></div>
    <section className="mt-8 border-y border-[var(--border)] py-6">
      <h2 className="text-lg font-semibold">{installed ? "Running in an app window" : "Install Local AI Lab"}</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-2)]">Training and models run on your computer. Your desktop and phone connect to the same live lab.</p>
      {prompt && <button onClick={install} className="mt-4 rounded-[var(--r-md)] bg-[var(--accent-ai)] px-5 py-3 font-semibold text-[var(--bg)]">Install LAL</button>}
      {!prompt && !installed && <p className="mt-4 text-sm text-[var(--text-2)]">Open this address in a regular browser tab, rather than inside another installed app. Then use the instructions below.</p>}
      {message && <p role="status" className="mt-3 text-sm text-[var(--accent-ai)]">{message}</p>}
      <Link href="/train" className="mt-4 inline-block text-sm text-[var(--accent-ai)] underline underline-offset-4">Open training</Link>
    </section>
    <div className="mt-6 grid gap-7 sm:grid-cols-2">
      <section><h2 className="font-semibold">Desktop</h2><p className="mt-2 text-sm leading-relaxed text-[var(--text-2)]">Open the private address in Chrome or Edge. Use the install icon in the address bar, or the browser menu’s install option. LAL opens in its own window.</p></section>
      <section><h2 className="font-semibold">Phone</h2><p className="mt-2 text-sm leading-relaxed text-[var(--text-2)]">Connect Tailscale to the same account and open the private address. On iPhone, use Safari’s Share menu, then Add to Home Screen. On Android, use Chrome’s Install app or Add to Home screen.</p></section>
    </div>
    <section className="mt-8 rounded-[var(--r-md)] border border-[var(--border)] p-4">
      <h2 className="font-semibold">Private address</h2><a href={address || "/"} className="mt-2 block break-all text-sm text-[var(--accent-ai)] underline underline-offset-4">{address || "Loading…"}</a>
      <button onClick={async () => { try { await navigator.clipboard.writeText(address); setMessage("Private address copied."); } catch { setMessage("Select the address above to copy it."); } }} disabled={!address} className="mt-3 rounded-[var(--r-md)] border border-[var(--border)] px-3 py-2 text-sm">Copy address</button>
      <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">Keep your computer awake and LAL running. Access follows your Tailscale network permissions. App data stays on the server; this app does not keep an offline dataset copy.</p>
    </section>
  </main>;
}
