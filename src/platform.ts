/** A Mac (or iOS) keyboard: ⌘ is the shortcut key, and Ctrl means something
 * else in text (Ctrl+P moves the caret up a line). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
