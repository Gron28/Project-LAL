/**
 * TTS for the assistant. Three voices, picked in settings:
 *  - "sam"       : classic Software Automatic Mouth (retro robotic)
 *  - "sam-clear" : SAM tuned slower/clearer — old-school but understandable
 *  - "system"    : the browser's standard voice (modern, clearest)
 * Speaks a QUEUE of sentence chunks so it can start while the reply is still
 * streaming, and reports the chunk currently being spoken (for subtitles + the
 * speaking animation).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type VoiceId = "sam" | "sam-clear" | "system";

const SAM_PRESETS: Record<string, any> = {
  sam: { pitch: 64, speed: 72, mouth: 128, throat: 128 },
  "sam-clear": { pitch: 72, speed: 92, mouth: 150, throat: 110 }, // slower + clearer
};

let currentVoice: VoiceId = "sam";
const samInstances: Record<string, any> = {};
let queue: string[] = [];
let draining = false;
let enabled = true;
let listener: ((nowSpeaking: string) => void) | null = null;

export function setVoice(v: string) {
  if (v === "sam" || v === "sam-clear" || v === "system") {
    currentVoice = v;
    try { localStorage.setItem("agent.ttsVoice", v); } catch { /* ignore */ }
  }
}
export function getVoice(): VoiceId {
  try { const s = localStorage.getItem("agent.ttsVoice"); if (s === "sam" || s === "sam-clear" || s === "system") currentVoice = s; } catch { /* ignore */ }
  return currentVoice;
}
/** Register a callback that receives the chunk being spoken ("" when idle). */
export function setSpeechListener(cb: ((nowSpeaking: string) => void) | null) { listener = cb; }

async function getSam(preset: string): Promise<any> {
  if (!samInstances[preset]) {
    const m = await import("sam-js");
    const Sam = (m as any).default || (m as any);
    samInstances[preset] = new Sam(SAM_PRESETS[preset] || SAM_PRESETS.sam);
  }
  return samInstances[preset];
}

function sanitize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " . code block . ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[*_#`>|~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speakSystem(text: string): Promise<void> {
  return new Promise((res) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    u.onend = () => res();
    u.onerror = () => res();
    window.speechSynthesis.speak(u);
  });
}

export function enqueueSpeech(text: string) {
  const clean = sanitize(text);
  if (!clean) return;
  enabled = true;
  queue.push(clean);
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    getVoice();
    while (queue.length && enabled) {
      const next = queue.shift();
      if (!next) break;
      listener?.(next);
      try {
        if (currentVoice === "system") await speakSystem(next);
        else await Promise.resolve((await getSam(currentVoice)).speak(next));
      } catch { /* keep going */ }
    }
  } catch { /* engine failed */ } finally {
    draining = false;
    listener?.("");
  }
}

export function stopSpeech() {
  enabled = false;
  queue = [];
  try { if (typeof window !== "undefined") window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  listener?.("");
}
