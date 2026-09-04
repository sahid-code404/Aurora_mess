/**
 * Cross-tab notification event channel.
 * Uses BroadcastChannel when available in browser environments to trigger
 * instant cache invalidation and feed updates across open tabs.
 */

const CHANNEL_NAME = "boardops-notifications";

export function broadcastNotification(event: string, data?: unknown): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return;
  }
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ event, data, timestamp: Date.now() });
    channel.close();
  } catch {
    // Ignore environments where BroadcastChannel is blocked
  }
}

export function onNotificationBroadcast(
  callback: (event: string, data?: unknown) => void
): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const handler = (msg: MessageEvent) => {
      if (msg.data && typeof msg.data.event === "string") {
        callback(msg.data.event, msg.data.data);
      }
    };
    channel.addEventListener("message", handler);
    return () => {
      channel.removeEventListener("message", handler);
      channel.close();
    };
  } catch {
    return () => {};
  }
}
