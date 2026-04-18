export interface CalendarEvent {
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

export async function fetchCalendarEvents(
  accessToken: string,
  date: string, // YYYY-MM-DD
): Promise<CalendarEvent[]> {
  const timeMin = encodeURIComponent(`${date}T00:00:00Z`);
  const timeMax = encodeURIComponent(`${date}T23:59:59Z`);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    console.error('[gcal] Error fetching events:', await resp.text());
    return [];
  }

  const data = await resp.json<{ items?: CalendarEvent[] }>();
  return data.items ?? [];
}
