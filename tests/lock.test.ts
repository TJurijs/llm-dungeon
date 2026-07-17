import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface WorkerMessage {
  type: "ready" | "acquired" | "locked" | "released" | "error";
  error?: string;
}

function messageOfType(child: ChildProcess, types: WorkerMessage["type"][]): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: WorkerMessage) => {
      if (!types.includes(value.type)) return;
      cleanup();
      resolve(value);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Lock worker exited before ${types.join("/")} (code ${String(code)})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

describe("filesystem lock", () => {
  it("elects only one owner when many processes reclaim the same stale lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-lock-race-"));
    const target = path.join(root, ".test.lock");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const exitedPid = exited.pid;
    await once(exited, "exit");
    if (!exitedPid) throw new Error("Could not obtain the exited lock-owner PID");
    await writeFile(target, `${JSON.stringify({
      pid: exitedPid,
      token: "stale-owner",
      createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });

    const workerPath = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
    const workerEntries = Array.from({ length: 16 }, () => {
      const worker = fork(workerPath, [target], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return {
        worker,
        ready: messageOfType(worker, ["ready"]),
        exited: once(worker, "exit"),
      };
    });
    const workers = workerEntries.map((entry) => entry.worker);

    try {
      await Promise.all(workerEntries.map((entry) => entry.ready));
      const outcomes = workers.map((worker) => messageOfType(worker, ["acquired", "locked", "error"]));
      for (const worker of workers) worker.send("go");
      const initial = await Promise.all(outcomes);
      const acquired = workers.filter((_, index) => initial[index]?.type === "acquired");
      expect(initial.filter((message) => message.type === "error")).toEqual([]);
      expect(acquired).toHaveLength(1);
      expect(initial.filter((message) => message.type === "locked")).toHaveLength(workers.length - 1);

      const released = messageOfType(acquired[0]!, ["released", "error"]);
      acquired[0]!.send("release");
      await expect(released).resolves.toEqual({ type: "released" });
      await Promise.all(workerEntries.map((entry) => entry.exited));
    } finally {
      for (const worker of workers) {
        if (worker.exitCode === null) worker.kill();
      }
      await Promise.allSettled(workerEntries.map((entry) => entry.exited));
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
