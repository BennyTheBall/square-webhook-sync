import { config } from './config.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { processSquareEvent } from './processor.js';

const db = createDb(config);

async function runOnce() {
  const events = await db.listPendingEvents({ limit: config.worker.limit });
  for (const event of events) {
    const payload = typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json;
    try {
      await processSquareEvent({ db, config, eventId: event.event_id, payload });
    } catch (error) {
      logger.error('Worker event processing failed', { eventId: event.event_id, error });
    }
  }
}

async function main() {
  logger.info('Retry worker started', { intervalMs: config.worker.intervalMs });
  while (true) {
    await runOnce();
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
