import type { Env } from '../types.js';
import { runIngestionPipeline } from '../ingestion/pipeline.js';
import { runSmoGenerationPipeline } from '../llm/smo.js';

// Cloudflare cron triggers call the scheduled() handler.
// wrangler.toml registers two crons:
//   45 2 * * *  → ingestion
//   30 3 * * *  → SMO generation
export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const now = new Date(event.scheduledTime);
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (hour === 2 && minute === 45) {
    await runIngestionPipeline(env);
  } else if (hour === 3 && minute === 30) {
    await runSmoGenerationPipeline(env);
  } else {
    console.log(`[cron] Unexpected schedule time ${hour}:${minute}, skipping`);
  }
}
