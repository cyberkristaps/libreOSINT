import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Inspector } from '../inspector/inspector';
import { Chat } from '../chat/chat';
import { UiState } from '../../core/services/ui-state';
import { ChatService } from '../../core/services/chat';

/** Right panel: Inspector and AI Chat tabs. Both stay mounted so chat state and scroll survive tab switches. */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Inspector, Chat],
  template: `
    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="tab"
        [class.active]="ui.rightTab() === 'inspector'"
        [attr.aria-selected]="ui.rightTab() === 'inspector'"
        (click)="ui.rightTab.set('inspector')"
      >
        Inspector
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        [class.active]="ui.rightTab() === 'chat'"
        [attr.aria-selected]="ui.rightTab() === 'chat'"
        (click)="ui.rightTab.set('chat')"
      >
        AI Chat
        @if (chat.busy()) {
          <span class="tab-dot busy" title="Working…"></span>
        } @else if (chat.pendingProposals()) {
          <span class="tab-count" title="Proposals waiting for review">{{ chat.pendingProposals() }}</span>
        }
      </button>
    </div>
    <div class="tab-body" [hidden]="ui.rightTab() !== 'inspector'"><app-inspector /></div>
    <div class="tab-body tab-body-chat" [hidden]="ui.rightTab() !== 'chat'"><app-chat /></div>
  `,
  host: { class: 'sidebar' },
})
export class Sidebar {
  protected readonly ui = inject(UiState);
  protected readonly chat = inject(ChatService);
}
