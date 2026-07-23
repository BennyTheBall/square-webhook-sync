import { config } from './config.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { processSquareEvent, retryFailedSyncResult } from './processor.js';
import { maybeSendDailySummary } from './summaryEmail.js';

const db = createDb(config);

export async function runOnce({ db, config }) {
  const events = await db.listPendingEvents({ limit: config.worker.limit });
  for (const event of events) {
    const payload = typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json;
    try {
      await processSquareEvent({ db, config, eventId: event.event_id, payload });
    } catch (error) {
      logger.error('Worker event processing failed', { eventId: event.event_id, error });
    }
  }

  const failedResults = await db.listFailedSyncResults?.({ limit: config.worker.limit }) || [];
  for (const result of failedResults) {
    try {
      await retryFailedSyncResult({ db, config, result });
    } catch (error) {
      logger.error('Worker transaction retry failed', {
        resultId: result.id,
        eventId: result.event_id,
        marketplace: result.marketplace,
        sku: result.sku,
        error,
      });
    }
  }
}

async function main() {
  logger.info('Retry worker started', { intervalMs: config.worker.intervalMs });
  while (true) {
    await runOnce({ db, config });
    try {
      await maybeSendDailySummary({ db, config });
    } catch (error) {
      logger.error('Daily summary check failed', { error });
    }
    await new Promise((resolve) => setTimeout(resolve, config.worker.intervalMs));
  }
}

async function shutdown() {
  await db.close?.();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(async (error) => {
  logger.error('Worker crashed', { error });
  await db.close?.();
  process.exit(1);
});
