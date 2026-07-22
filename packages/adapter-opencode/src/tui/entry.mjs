const runtimeProbe = "opentui:runtime-module:" + encodeURIComponent("@opentui/solid");

function isMissingRuntimeRegistry(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(message) &&
    message.includes("opentui:runtime-module:");
}

let mod;
try {
  await import(runtimeProbe);
} catch (error) {
  if (!isMissingRuntimeRegistry(error)) {
    console.error("[ai-agent-local-memory] TUI runtime probe failed", error);
    throw error;
  }
  mod = await import("./index.tsx");
}

if (!mod) {
  mod = await import("../tui-compiled/index.tsx");
}

export default mod.default;
