import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ConsoleLog } from '../../core/services/console-log';

@Component({
  selector: 'app-console',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="console-header">
      <button type="button" class="link" (click)="toggle.emit()" [attr.aria-expanded]="!collapsed()">
        {{ collapsed() ? '▸' : '▾' }} Transform console ({{ log.lines().length }})
      </button>
      @if (!collapsed()) {
        <button type="button" class="link" (click)="log.clear()">Clear</button>
      }
    </div>
    @if (!collapsed()) {
      <ol class="console-lines">
        @for (l of log.lines(); track $index) {
          <li [class]="'lvl-' + l.level">
            <time>{{ l.at | date: 'HH:mm:ss' }}</time>
            <span class="src">[{{ l.source }}]</span>
            {{ l.text }}
          </li>
        } @empty {
          <li class="muted">No transform runs yet.</li>
        }
      </ol>
    }
  `,
})
export class Console {
  protected readonly log = inject(ConsoleLog);
  readonly collapsed = input.required<boolean>();
  readonly toggle = output<void>();
}
