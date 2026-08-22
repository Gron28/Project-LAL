/** Generated previews execute in an opaque-origin sandbox. In particular, this
 * must never include allow-same-origin alongside allow-scripts: that would make
 * preview code able to act as the owner WebUI origin. */
export const GENERATED_PREVIEW_CSP = "sandbox allow-scripts allow-pointer-lock allow-modals allow-forms";
