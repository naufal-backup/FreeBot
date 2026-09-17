// src/pendingActions.js
// In-memory pending actions with TTL expiration
// Used for Google Sheets edit confirmation flow

const pendingActions = new Map();
const ACTION_TTL_MS = 120000; // 2 minutes

export function setPendingAction(chatId, action) {
  pendingActions.set(chatId, { ...action, timestamp: Date.now() });
}

export function getPendingAction(chatId) {
  const action = pendingActions.get(chatId);
  if (!action) return null;
  if (Date.now() - action.timestamp > ACTION_TTL_MS) {
    pendingActions.delete(chatId);
    return null;
  }
  return action;
}

export function clearPendingAction(chatId) {
  pendingActions.delete(chatId);
}
