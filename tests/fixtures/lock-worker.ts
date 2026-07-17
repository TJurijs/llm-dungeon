import { acquireFileLock } from "../../src/persistence/lock.js";

const target = process.argv[2];
if (!target || !process.send) throw new Error("Lock worker requires an IPC channel and target path");

process.send({ type: "ready" });
process.once("message", async (message) => {
  if (message !== "go") return;
  try {
    const release = await acquireFileLock(target, "Worker lock");
    process.send?.({ type: "acquired" });
    process.once("message", async (nextMessage) => {
      if (nextMessage !== "release") return;
      try {
        await release();
        process.send?.({ type: "released" });
      } catch (error) {
        process.send?.({ type: "error", error: String((error as Error).message) });
      } finally {
        process.disconnect();
      }
    });
  } catch (error) {
    const message = String((error as Error).message);
    process.send?.({ type: /locked by another running process/i.test(message) ? "locked" : "error", error: message });
    process.disconnect();
  }
});
