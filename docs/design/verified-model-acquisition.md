# Verified model acquisition foundation

Slice 5 begins at `web/src/lib/model-acquisition.ts`. It intentionally does not implement a downloader or make provider network calls. A separately authorized Hugging Face or Ollama metadata adapter supplies an offline catalog with exact revision, license, relative file name, byte size, and SHA-256 digest.

`resolveModelAcquisition()` produces a plan only when the provider catalog is available, the requested revision exists, any required license was accepted, and disk/RAM/optional VRAM estimates fit. Offline and unconfigured adapters return a visible typed result; they never silently fall back to the network.

`VerifiedModelImportStore` accepts bytes only from a future, explicitly authorized transport adapter (no URL is accepted here), bounds staged size, supports durable cancellation, requires exact SHA-256 and size match, then atomically moves verified bytes into a content-addressed artifact name. A mismatch remains `failed` and never becomes active.

This foundation is deliberately not yet connected to a browser download button, provider credentials, or active runtime registry. Those integrations must pass the same authorization, egress, retention, and registry-promotion boundaries.
