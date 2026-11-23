import { Injectable, signal } from '@angular/core';
import { LogLevel } from '../models/transform';

export interface LogLine {
  at: Date;
  level: LogLevel;
  source: string;
  text: string;
}

const MAX_LINES = 2000;

@Injectable({ providedIn: 'root' })
export class ConsoleLog {
  readonly lines = signal<LogLine[]>([]);
  readonly collapsed = signal(false);

  log(level: LogLevel, source: string, text: string): void {
    this.lines.update((ls) => [...ls.slice(-(MAX_LINES - 1)), { at: new Date(), level, source, text }]);
  }

  clear(): void {
    this.lines.set([]);
  }
}
