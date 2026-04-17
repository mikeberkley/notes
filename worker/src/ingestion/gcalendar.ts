import { insertRawSource } from '../db/queries.js';

interface CalendarEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; displayName?: string; self?: boolean }>;
  status?: string;
}

interface CalendarListResponse {
  items?: CalendarEvent[];
}

export async function ingestGCalendar(
  db: D1Database,
  accessToken: string,
  userId: string,
  date: string, // YYYY-MM-DD
): Promise<void> {
  const params = new URLSearchParams({
    timeMin: `${date}T00:00:00Z`,
    timeMax: `${date}T23:59:59Z`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!resp.ok) {
    console.error('[gcalendar] API error:', await resp.text());
    return;
  }

  const data = await resp.json<CalendarListResponse>();
  const events = (data.items ?? []).filter(e => e.status !== 'cancelled');

  for (const event of events) {
    const title = event.summary ?? '(untitled event)';
    const start = event.start.dateTime ?? event.start.date ?? '';
    const end = event.end.dateTime ?? event.end.date ?? '';
    const location = event.location ?? '';
    const description = event.description ?? '';
    const attendees = (event.attendees ?? [])
      .filter(a => !a.self)
      .map(a => a.displayName ?? a.email);

    const lines = [`Title: ${title}`, `Time: ${start} → ${end}`];
    if (location) lines.push(`Location: ${location}`);
    if (attendees.length) lines.push(`Attendees: ${attendees.slice(0, 10).join(', ')}`);
    if (description) lines.push(`Description: ${description.slice(0, 500)}`);

    const content = lines.join('\n');
    const metadata = { title, start, end, location, attendee_count: attendees.length };

    await insertRawSource(db, userId, 'gcalendar', event.id, content, metadata, date);
  }

  console.log(`[gcalendar] Ingested ${events.length} event(s) for ${date}`);
}
