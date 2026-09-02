import { runRetentionPurge } from './purge';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startRetentionScheduler(): void {
  const run = async () => {
    try {
      const result = await runRetentionPurge();
      if (result.conversationEntriesDeleted > 0 || result.expiredCacheEntriesDeleted > 0) {
        console.log(`[retention] Purged ${result.conversationEntriesDeleted} conversation entries, ${result.expiredCacheEntriesDeleted} expired cache entries`);
      }
    } catch (err) {
      console.error('[retention] Purge job failed:', err);
    }
  };

  setInterval(run, ONE_DAY_MS);
  console.log('[retention] Scheduled daily purge job');
}
