"use client";
import { useEffect } from "react";
export default function AppRegistration() {
  useEffect(() => {
    const target = window as Window & { lalInstallPrompt?: Event };
    const capture = (event: Event) => { event.preventDefault(); target.lalInstallPrompt = event; window.dispatchEvent(new Event("lal-install-available")); };
    const clear = () => { delete target.lalInstallPrompt; };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", clear);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/lal-app-worker.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
    }
    return () => { window.removeEventListener("beforeinstallprompt", capture); window.removeEventListener("appinstalled", clear); };
  }, []);
  return null;
}
