export function eventTimestamp(value: string | null | undefined, edition: string, timeZone?: string | null): number | null;
export function eventCountdown(start: number | null, end: number | null, now: number, en?: boolean): {state:'unknown'|'upcoming'|'active'|'ended'; label:string};
export function formatEventTime(value: string | null | undefined, edition: string, timeZone?: string | null, seconds?: boolean): string;
export function eventTimeLabel(edition: string, en?: boolean): string;
