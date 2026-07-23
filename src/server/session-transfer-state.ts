const state = globalThis as unknown as {
  __upgradingLocalSessionIds?: Set<string>;
};

const upgradingLocalSessionIds = (state.__upgradingLocalSessionIds ??= new Set());

export function beginLocalSessionUpgrade(sessionId: string): boolean {
  if (upgradingLocalSessionIds.has(sessionId)) return false;
  upgradingLocalSessionIds.add(sessionId);
  return true;
}

export function endLocalSessionUpgrade(sessionId: string): void {
  upgradingLocalSessionIds.delete(sessionId);
}

export function isLocalSessionUpgradeInProgress(sessionId: string): boolean {
  return upgradingLocalSessionIds.has(sessionId);
}
