import type { GuideStep } from "@/components/ui/page-guide";

// Onboarding copy for each page, in one place so it stays consistent.
export const GUIDES: Record<string, { intro: string; steps: GuideStep[] }> = {
  train: {
    intro: "Fine-tuning teaches an existing model new behavior from your examples. Nothing leaves this computer.",
    steps: [
      { title: "Pick a base model", body: "Start small (≤4B) for a first run. HQQ 4-bit lets 4–8B models fit an 8 GB GPU." },
      { title: "Add data", body: "An instruction dataset (question → answer pairs) or plain text. Upload a file or manage datasets." },
      { title: "Start and watch", body: "Loss should fall and level off. Validation loss rising while loss falls means it is memorizing." },
      { title: "Prove it improved", body: "Compare the new model to its base on the same suites.", href: "/benchmark", cta: "Open Evaluation" },
    ],
  },
  models: {
    intro: "Every model LAL can run: local GGUF files and Ollama models. Load one to the GPU, set defaults, or tune its context.",
    steps: [
      { title: "Get a model", body: "Download from the catalog or import a file you already have." },
      { title: "Set a default", body: "The default is what Chat and Code use unless you pick another." },
      { title: "Load it", body: "“Load now” puts it on the GPU so the first reply is fast." },
      { title: "Optimize context", body: "Finds the largest context window that fits your VRAM safely." },
    ],
  },
  benchmark: {
    intro: "Evaluation scores models on fixed test suites so you can compare them honestly: same questions, same grader.",
    steps: [
      { title: "Choose a suite", body: "Coding, reasoning, planning… each is a fixed set of graded tasks." },
      { title: "Run it", body: "Run the suite on one or more models. Speed (tok/s) is recorded too." },
      { title: "Compare", body: "Quality shows scores; Deployment shows how models run on real devices." },
      { title: "Inspect", body: "Lens shows token-level confidence to explain why a model failed." },
    ],
  },
  library: {
    intro: "History keeps everything LAL has done: runs, chats, experiments, projects, documents and prompts.",
    steps: [
      { title: "Runs", body: "Every agent run with its outcome. The report card ranks models by clean vs. failed runs." },
      { title: "Chats", body: "Reopen any conversation in Chat or Code where you left off." },
      { title: "Documents", body: "Files you give LAL for grounding. The Training Data folder feeds the Lab." },
      { title: "Experiments", body: "Training and evaluation records you can compare over time." },
    ],
  },
};
