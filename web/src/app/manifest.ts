import type { MetadataRoute } from "next";
import { TOKENS } from "@/lib/design-tokens";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/apps/local-ai-lab", name: "LAL", short_name: "LAL",
    description: "Your local models, datasets, training, and experiments.",
    start_url: "/?app=local-ai-lab", scope: "/", display: "standalone",
    background_color: TOKENS.bg.canvas, theme_color: TOKENS.bg.canvas,
    icons: [
      { src: "/app-icons/icon-192-v5.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icons/icon-512-v5.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icons/maskable-512-v5.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Training", url: "/train" },
      { name: "Models", url: "/models" },
    ],
  };
}
