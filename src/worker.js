import { config } from './config.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { processSquareEvent } from './processor.js';

const db = createDb(config);

async function main() {
  const events = await db.listPendingEvents({ limit: config.worker.limit });
  for (const event of events) {
    const payload = typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json;
    try {
      await processSquareEvent({ db, config, eventId: event.event_id, payload });
    } catch (error) {
      logger.error('Worker event processing failed', { eventId: event.event_id, error });
    }
  }
  await db.close?.();
}

main().catch(async (error) => {
  logger.error('Worker crashed', { error });
  await db.close?.();
  process.exit(1);
});
