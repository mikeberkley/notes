import type { Env } from '../types.js';
import { getAllUsersWithTokens, refreshOAuthAccessToken } from '../db/queries.js';
import { daysAgo } from '../db/utils.js';
import { ingestGmail } from './gmail.js';
import { ingestGDrive } from './gdrive.js';
import { ingestWorkflowy } from './workflowy.js';
import { ingestSlack } from './slack.js';
import { ingestGCalendar } from './gcalendar.js';

export async function runIngestionPipeline(env: Env, date?: string): Promise<void> {
  const targetDate = date ?? daysAgo(new Date(), 1);
  console.log(`[ingestion] Starting pipeline for ${targetDate}`);

  const users = await getAllUsersWithTokens(env.DB);
  console.log(`[ingestion] ${users.length} user(s) to process`);

  for (const user of users) {
    try {
      const accessToken = await refreshOAuthAccessToken(env.DB, env, user.id);
      if (!accessToken) {
        console.error(`[ingestion] No valid access token for user ${user.id}`);
        continue;
      }

      await ingestGmail(env.DB, accessToken, user.id, targetDate);
      await ingestGDrive(env.DB, accessToken, user.id, targetDate, env);
      await ingestWorkflowy(env.DB, user.id, targetDate);
      await ingestSlack(env.DB, user.id, targetDate);
      await ingestGCalendar(env.DB, accessToken, user.id, targetDate);

      console.log(`[ingestion] Completed for user ${user.id}`);
    } catch (err) {
      console.error(`[ingestion] User ${user.id} failed:`, err);
    }
  }

  console.log(`[ingestion] Pipeline complete for ${targetDate}`);
}
