import axios from 'axios';
import { ICalEvent } from '../types/ical.types';

export class ICalService {
    /**
     * Parse iCal feed from URL and extract events
     */
    static async fetchEvents(url: string): Promise<ICalEvent[]> {
        try {
            const response = await axios.get(url, { timeout: 30000 });
            return this.parseICalData(response.data);
        } catch (error) {
            console.error(`Failed to fetch iCal from ${url}:`, error);
            throw new Error(`Failed to fetch iCal from ${url}`);
        }
    }

    /**
     * Parse raw iCal text data into ICalEvent objects
     */
    static parseICalData(icalData: string): ICalEvent[] {
        const events: ICalEvent[] = [];
        const lines = icalData.split('\n').map(line => line.trim());
        
        let currentEvent: Partial<ICalEvent> | null = null;
        
        for (const line of lines) {
            if (line === 'BEGIN:VEVENT') {
                currentEvent = {};
            } else if (line === 'END:VEVENT') {
                if (currentEvent && currentEvent.startDate && currentEvent.summary) {
                    events.push({
                        startDate: currentEvent.startDate,
                        location: currentEvent.location || '',
                        summary: currentEvent.summary
                    });
                }
                currentEvent = null;
            } else if (currentEvent) {
                if (line.startsWith('DTSTART')) {
                    // Handle both DTSTART:20251010T200000 and DTSTART;TZID=...:20251010T200000
                    const dateMatch = line.match(/(\d{8}T\d{6})/);
                    if (dateMatch) {
                        const dateStr = dateMatch[1];
                        // Parse: YYYYMMDDTHHMMSS
                        const year = parseInt(dateStr.substring(0, 4));
                        const month = parseInt(dateStr.substring(4, 6)) - 1;
                        const day = parseInt(dateStr.substring(6, 8));
                        const hour = parseInt(dateStr.substring(9, 11));
                        const minute = parseInt(dateStr.substring(11, 13));
                        const second = parseInt(dateStr.substring(13, 15));
                        currentEvent.startDate = new Date(year, month, day, hour, minute, second);
                    }
                } else if (line.startsWith('LOCATION:')) {
                    currentEvent.location = line.substring(9).replace(/\\,/g, ',').replace(/\\n/g, '\n');
                } else if (line.startsWith('SUMMARY:')) {
                    currentEvent.summary = line.substring(8).replace(/\\,/g, ',').replace(/\\n/g, '\n');
                }
            }
        }
        
        return events;
    }
}
