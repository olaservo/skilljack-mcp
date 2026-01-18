/**
 * Resource subscription management with file watching.
 *
 * Tracks client subscriptions to resource URIs and watches underlying files
 * using chokidar. When files change, sends notifications/resources/updated
 * to subscribed clients.
 *
 * URI patterns supported:
 * - skill://              → Watch all skill directories
 * - skill://{name}        → Watch that skill's SKILL.md
 * - skill://{name}/       → Watch entire skill directory (directory collection)
 * - skill://{name}/{path} → Watch specific file (subscribable but not listed as resource)
 */

import chokidar, { FSWatcher } from "chokidar";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SkillState, isPathWithinBase } from "./skill-tool.js";

/**
 * Manages active subscriptions and their associated file watchers.
 */
export interface SubscriptionManager {
  /** URI -> Set of file paths being watched for this URI */
  uriToFilePaths: Map<string, Set<string>>;

  /** File path -> Set of URIs that depend on this file */
  filePathToUris: Map<string, Set<string>>;

  /** File path -> chokidar watcher instance */
  watchers: Map<string, FSWatcher>;

  /** Pending notification timeouts for debouncing (URI -> timeout) */
  pendingNotifications: Map<string, NodeJS.Timeout>;
}

/** Debounce delay in milliseconds */
const DEBOUNCE_MS = 100;

/**
 * Create a new subscription manager.
 */
export function createSubscriptionManager(): SubscriptionManager {
  return {
    uriToFilePaths: new Map(),
    filePathToUris: new Map(),
    watchers: new Map(),
    pendingNotifications: new Map(),
  };
}

/**
 * Resolve a skill:// URI to the file paths it depends on.
 *
 * @param uri - The resource URI
 * @param skillState - Current skill state for lookups
 * @returns Array of absolute file paths to watch
 */
export function resolveUriToFilePaths(
  uri: string,
  skillState: SkillState
): string[] {
  // skill:// → Watch all skill directories
  if (uri === "skill://") {
    const paths: string[] = [];
    for (const skill of skillState.skillMap.values()) {
      paths.push(path.dirname(skill.path)); // Watch entire skill directory
    }
    return paths;
  }

  // skill://{skillName} → Just the SKILL.md file
  const skillMatch = uri.match(/^skill:\/\/([^/]+)$/);
  if (skillMatch) {
    const skillName = decodeURIComponent(skillMatch[1]);
    const skill = skillState.skillMap.get(skillName);
    return skill ? [skill.path] : [];
  }

  // skill://{skillName}/ → Watch entire skill directory (directory collection)
  const dirMatch = uri.match(/^skill:\/\/([^/]+)\/$/);
  if (dirMatch) {
    const skillName = decodeURIComponent(dirMatch[1]);
    const skill = skillState.skillMap.get(skillName);
    return skill ? [path.dirname(skill.path)] : [];
  }

  // skill://{skillName}/{path} → Specific file
  const fileMatch = uri.match(/^skill:\/\/([^/]+)\/(.+)$/);
  if (fileMatch) {
    const skillName = decodeURIComponent(fileMatch[1]);
    const filePath = fileMatch[2];
    const skill = skillState.skillMap.get(skillName);
    if (!skill) return [];

    const skillDir = path.dirname(skill.path);
    const fullPath = path.resolve(skillDir, filePath);

    // Security check: ensure path is within skill directory
    if (!isPathWithinBase(fullPath, skillDir)) return [];

    return [fullPath];
  }

  return [];
}

/**
 * Add a subscription for a URI.
 *
 * @param manager - The subscription manager
 * @param uri - The resource URI to subscribe to
 * @param skillState - Current skill state for resolving URIs
 * @param onNotify - Callback to send notification when file changes
 * @returns True if subscription was added, false if URI couldn't be resolved
 */
export function subscribe(
  manager: SubscriptionManager,
  uri: string,
  skillState: SkillState,
  onNotify: (uri: string) => void
): boolean {
  const filePaths = resolveUriToFilePaths(uri, skillState);
  if (filePaths.length === 0) {
    return false;
  }

  // Track URI -> file paths mapping
  manager.uriToFilePaths.set(uri, new Set(filePaths));

  // Track reverse mapping and set up watchers
  for (const filePath of filePaths) {
    // Add to reverse mapping
    let uris = manager.filePathToUris.get(filePath);
    if (!uris) {
      uris = new Set();
      manager.filePathToUris.set(filePath, uris);
    }
    uris.add(uri);

    // Set up watcher if not already watching this path
    if (!manager.watchers.has(filePath)) {
      const watcher = createWatcher(filePath, manager, onNotify);
      manager.watchers.set(filePath, watcher);
    }
  }

  console.error(`Subscribed to ${uri} (watching ${filePaths.length} path(s))`);
  return true;
}

/**
 * Remove a subscription for a URI.
 *
 * @param manager - The subscription manager
 * @param uri - The resource URI to unsubscribe from
 */
export function unsubscribe(
  manager: SubscriptionManager,
  uri: string
): void {
  const filePaths = manager.uriToFilePaths.get(uri);
  if (!filePaths) {
    return;
  }

  // Remove URI from each file path's set
  for (const filePath of filePaths) {
    const uris = manager.filePathToUris.get(filePath);
    if (uris) {
      uris.delete(uri);

      // If no more URIs depend on this file, stop watching
      if (uris.size === 0) {
        manager.filePathToUris.delete(filePath);

        const watcher = manager.watchers.get(filePath);
        if (watcher) {
          watcher.close();
          manager.watchers.delete(filePath);
        }
      }
    }
  }

  // Remove the URI entry
  manager.uriToFilePaths.delete(uri);

  // Clear any pending notification
  const pending = manager.pendingNotifications.get(uri);
  if (pending) {
    clearTimeout(pending);
    manager.pendingNotifications.delete(uri);
  }

  console.error(`Unsubscribed from ${uri}`);
}

/**
 * Create a chokidar watcher for a file or directory.
 */
function createWatcher(
  filePath: string,
  manager: SubscriptionManager,
  onNotify: (uri: string) => void
): FSWatcher {
  const watcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 50,
    },
  });

  const handleChange = (changedPath: string) => {
    // Normalize path for consistent lookup
    const normalizedPath = path.normalize(changedPath);

    // Find all URIs affected by this file change
    // For directory watches, check if the changed file is within any watched directory
    for (const [watchedPath, uris] of manager.filePathToUris.entries()) {
      const isMatch =
        normalizedPath === watchedPath ||
        normalizedPath.startsWith(watchedPath + path.sep);

      if (isMatch) {
        for (const uri of uris) {
          // Debounce: clear existing timeout, set new one
          const existing = manager.pendingNotifications.get(uri);
          if (existing) {
            clearTimeout(existing);
          }

          manager.pendingNotifications.set(
            uri,
            setTimeout(() => {
              manager.pendingNotifications.delete(uri);
              console.error(`Resource updated: ${uri}`);
              onNotify(uri);
            }, DEBOUNCE_MS)
          );
        }
      }
    }
  };

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("unlink", handleChange);

  return watcher;
}

/**
 * Update subscriptions when skills change.
 *
 * Re-resolves all existing URIs with the new skill state and updates
 * watchers accordingly. Sends notifications for any URIs whose underlying
 * files have changed.
 *
 * @param manager - The subscription manager
 * @param skillState - Updated skill state
 * @param onNotify - Callback to send notification
 */
export function refreshSubscriptions(
  manager: SubscriptionManager,
  skillState: SkillState,
  onNotify: (uri: string) => void
): void {
  // Re-resolve each subscribed URI
  for (const uri of manager.uriToFilePaths.keys()) {
    const oldPaths = manager.uriToFilePaths.get(uri)!;
    const newPaths = new Set(resolveUriToFilePaths(uri, skillState));

    // Find paths that were removed
    for (const oldPath of oldPaths) {
      if (!newPaths.has(oldPath)) {
        // Remove this URI from the old path's set
        const uris = manager.filePathToUris.get(oldPath);
        if (uris) {
          uris.delete(uri);
          if (uris.size === 0) {
            manager.filePathToUris.delete(oldPath);
            const watcher = manager.watchers.get(oldPath);
            if (watcher) {
              watcher.close();
              manager.watchers.delete(oldPath);
            }
          }
        }
      }
    }

    // Find paths that were added
    for (const newPath of newPaths) {
      if (!oldPaths.has(newPath)) {
        // Add this URI to the new path's set
        let uris = manager.filePathToUris.get(newPath);
        if (!uris) {
          uris = new Set();
          manager.filePathToUris.set(newPath, uris);
        }
        uris.add(uri);

        // Start watching if not already
        if (!manager.watchers.has(newPath)) {
          const watcher = createWatcher(newPath, manager, onNotify);
          manager.watchers.set(newPath, watcher);
        }
      }
    }

    // Update the stored paths
    if (newPaths.size === 0) {
      // URI no longer resolves to anything - remove subscription
      manager.uriToFilePaths.delete(uri);
      console.error(`Subscription ${uri} no longer valid (skill removed?)`);
    } else {
      manager.uriToFilePaths.set(uri, newPaths);
    }
  }
}

/**
 * Register subscribe/unsubscribe request handlers with the server.
 *
 * @param server - The MCP server instance
 * @param skillState - Shared skill state
 * @param manager - The subscription manager
 */
export function registerSubscriptionHandlers(
  server: McpServer,
  skillState: SkillState,
  manager: SubscriptionManager
): void {
  const sendNotification = (uri: string) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  };

  // Handle resources/subscribe requests
  server.server.setRequestHandler(
    SubscribeRequestSchema,
    async (request) => {
      const { uri } = request.params;

      // Validate URI scheme
      if (!uri.startsWith("skill://")) {
        throw new Error(`Unsupported URI scheme: ${uri}. Only skill:// URIs are supported.`);
      }

      const success = subscribe(manager, uri, skillState, sendNotification);
      if (!success) {
        throw new Error(`Resource not found: ${uri}`);
      }

      return {};
    }
  );

  // Handle resources/unsubscribe requests
  server.server.setRequestHandler(
    UnsubscribeRequestSchema,
    async (request) => {
      const { uri } = request.params;
      unsubscribe(manager, uri);
      return {};
    }
  );
}
