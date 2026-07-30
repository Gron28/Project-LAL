type InstrumentationGlobal = typeof globalThis & { __lal_shutdown_handlers?: boolean };

const state = globalThis as InstrumentationGlobal;
if (!state.__lal_shutdown_handlers) {
  state.__lal_shutdown_handlers = true;
  const stop = async (signal: NodeJS.Signals) => {
    try {
      const { shutdownLab } = await import("./lib/lab");
      await shutdownLab();
      process.exit(0);
    } catch (error) {
      console.error(`Project-LAL shutdown after ${signal} failed:`, error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  process.once("SIGINT", () => { void stop("SIGINT"); });
}

export {};
