"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

type Snapshot = {
  current?: string;
  models?: string[];
  settingsRevision?: string;
  modelSettings?: Record<string, { thinking?: boolean }>;
};

/** Poll the host-owned model policy. Changes made on /models take effect in
 * already-open browser tabs on the next turn without a reload. */
export function useModelSettingsSync(args: {
  model: string;
  adoptDefault: boolean;
  setModel: Dispatch<SetStateAction<string>>;
  setModels: Dispatch<SetStateAction<string[]>>;
  setThinking: Dispatch<SetStateAction<boolean>>;
}) {
  const { model, adoptDefault, setModel, setModels, setThinking } = args;
  const applied = useRef("");
  useEffect(() => {
    let stopped = false;
    const sync = async () => {
      try {
        const response = await fetch("/api/agent/models", { cache: "no-store" });
        if (!response.ok || stopped) return;
        const snapshot = await response.json() as Snapshot;
        const selected = adoptDefault && snapshot.current ? snapshot.current : model || snapshot.current || "";
        const key = `${snapshot.settingsRevision || "none"}:${selected}:${adoptDefault}`;
        if (key === applied.current) return;
        applied.current = key;
        if (Array.isArray(snapshot.models)) setModels(snapshot.models);
        if (adoptDefault && snapshot.current) setModel(snapshot.current);
        const thinking = snapshot.modelSettings?.[selected]?.thinking;
        if (typeof thinking === "boolean") setThinking(thinking);
      } catch { /* offline tabs retain their last local snapshot */ }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [model, adoptDefault, setModel, setModels, setThinking]);
}
