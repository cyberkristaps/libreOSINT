import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { JsonPipe } from '@angular/common';
import { ChatService } from '../../core/services/chat';
import { ChatSettings } from '../../core/services/chat-settings';
import { GraphStore } from '../../core/services/graph-store';
import { TauriBridge } from '../../core/services/tauri-bridge';
import { renderMarkdown } from '../../core/models/markdown';
import { ENTITY_META } from '../../core/models/entity-meta';
import { ChatMessage, Proposal } from '../../core/models/chat';
import { EntityType, isEntityType } from '../../core/models/entity';

@Component({
  selector: 'app-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JsonPipe],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
  host: { class: 'chat' },
})
export class Chat implements OnInit {
  protected readonly chat = inject(ChatService);
  protected readonly settings = inject(ChatSettings);
  protected readonly store = inject(GraphStore);
  private readonly bridge = inject(TauriBridge);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly logEl = viewChild<ElementRef<HTMLElement>>('log');

  protected readonly settingsOpen = signal(false);
  protected readonly models = signal<string[]>([]);
  protected readonly modelStatus = signal<'unknown' | 'loading' | 'ok' | 'error'>('unknown');
  protected readonly modelError = signal('');
  protected readonly meta = ENTITY_META;
  protected readonly selectedCount = computed(() => this.store.selectedIds().length);
  protected readonly suggestions = [
    'Investigate the selected entity and add what you find to the graph.',
    'Find subdomains and hosting for the selected domain.',
    'Who owns the selected IP address?',
    'Summarize this investigation so far.',
  ];
  private readonly htmlCache = new Map<string, SafeHtml>();

  constructor() {
    // Keep the newest message in view.
    afterRenderEffect(() => {
      this.chat.messages();
      const el = this.logEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  ngOnInit(): void {
    void this.refreshModels();
  }

  async refreshModels(): Promise<void> {
    this.modelStatus.set('loading');
    try {
      const names = await this.bridge.ollamaModels(this.settings.url());
      this.models.set(names);
      this.modelStatus.set('ok');
      this.modelError.set(names.length ? '' : 'Ollama is running but has no models. Pull one, e.g. `ollama pull qwen3`.');
      if (names.length && !names.includes(this.settings.model())) this.settings.model.set(names[0]);
    } catch (err) {
      this.models.set([]);
      this.modelStatus.set('error');
      this.modelError.set((err as Error).message);
    }
  }

  protected setUrl(value: string): void {
    this.settings.url.set(value.trim() || 'http://localhost:11434');
    void this.refreshModels();
  }

  protected send(ev?: Event): void {
    ev?.preventDefault();
    const text = this.chat.draft();
    if (!text.trim() || this.chat.busy()) return;
    this.chat.draft.set('');
    void this.chat.send(text);
  }

  protected onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) this.send(ev);
  }

  protected md(text: string): SafeHtml {
    let html = this.htmlCache.get(text);
    if (!html) {
      // renderMarkdown escapes all input; only its own whitelisted tags are emitted.
      html = this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(text));
      if (this.htmlCache.size > 500) this.htmlCache.clear();
      this.htmlCache.set(text, html);
    }
    return html;
  }

  /** Links in replies open in the system browser; the webview never navigates. */
  protected onContentClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    ev.preventDefault();
    void this.bridge.openExternal(a.getAttribute('href') ?? '');
  }

  protected labelOf(ref: string | undefined): string {
    return this.chat.labelOf(ref);
  }

  protected colorOf(type: string): string {
    return isEntityType(type) ? this.meta[type as EntityType].color : '#64748b';
  }

  protected pendingIn(m: ChatMessage): number {
    return m.meta?.proposals.filter((p) => p.status === 'pending' || p.status === 'error').length ?? 0;
  }

  protected propsOf(p: Proposal): [string, string][] {
    if (p.kind !== 'entity') return [];
    return Object.entries(p.args.properties ?? {})
      .slice(0, 6)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }

  protected useSuggestion(text: string): void {
    this.chat.draft.set(text);
  }
}
