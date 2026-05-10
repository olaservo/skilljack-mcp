/**
 * Well-known publisher polling.
 *
 * Periodically checks each configured publisher's index.json for changes
 * and triggers a sync when the document has actually moved. Uses the same
 * shape as github-polling.ts so the wiring in index.ts is symmetrical.
 */

import { WellKnownSpec } from "./well-known-config.js";
import { SyncOptions, SyncResult, hasRemoteUpdates, syncWellKnown } from "./well-known-sync.js";

export interface PollingOptions {
  intervalMs: number;
  onUpdate: (spec: WellKnownSpec, result: SyncResult) => void;
  onError?: (spec: WellKnownSpec, error: Error) => void;
}

export interface PollingManager {
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
  isRunning(): boolean;
}

export function createWellKnownPollingManager(
  specs: WellKnownSpec[],
  syncOptions: SyncOptions,
  pollingOptions: PollingOptions
): PollingManager {
  let intervalId: NodeJS.Timeout | null = null;
  let isChecking = false;

  async function checkForUpdates(): Promise<void> {
    if (isChecking) {
      console.error("Well-known polling: already checking, skipping...");
      return;
    }
    if (specs.length === 0) return;

    isChecking = true;
    console.error(`Well-known polling: checking ${specs.length} publisher(s) for updates...`);

    for (const spec of specs) {
      try {
        const hasUpdates = await hasRemoteUpdates(spec, syncOptions);
        if (!hasUpdates) continue;

        console.error(`Well-known polling: updates available for ${spec.origin}`);
        const result = await syncWellKnown(spec, syncOptions);
        if (!result.error && result.updated) {
          pollingOptions.onUpdate(spec, result);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(
          `Well-known polling: error checking ${spec.origin}: ${err.message}`
        );
        pollingOptions.onError?.(spec, err);
      }
    }

    isChecking = false;
  }

  return {
    start(): void {
      if (intervalId !== null) {
        console.error("Well-known polling: already running");
        return;
      }
      if (pollingOptions.intervalMs <= 0) {
        console.error("Well-known polling: disabled (interval <= 0)");
        return;
      }
      if (specs.length === 0) {
        console.error("Well-known polling: not starting (no publishers configured)");
        return;
      }

      console.error(
        `Well-known polling: starting with ${pollingOptions.intervalMs}ms interval ` +
          `for ${specs.length} publisher(s)`
      );

      intervalId = setInterval(() => {
        checkForUpdates().catch((error) => {
          console.error(`Well-known polling: unexpected error: ${error}`);
        });
      }, pollingOptions.intervalMs);
    },

    stop(): void {
      if (intervalId === null) return;
      console.error("Well-known polling: stopping");
      clearInterval(intervalId);
      intervalId = null;
    },

    async checkNow(): Promise<void> {
      await checkForUpdates();
    },

    isRunning(): boolean {
      return intervalId !== null;
    },
  };
}
