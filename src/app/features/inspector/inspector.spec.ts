import { TestBed } from '@angular/core/testing';
import { Inspector, parsePropertyText, propertyText } from './inspector';
import { GraphStore } from '../../core/services/graph-store';

describe('property text round-trip', () => {
  it('keeps JSON types and plain text', () => {
    expect(parsePropertyText('443')).toBe(443);
    expect(parsePropertyText('true')).toBe(true);
    expect(parsePropertyText('["a","b"]')).toEqual(['a', 'b']);
    expect(parsePropertyText('Riga')).toBe('Riga');
    expect(parsePropertyText('12 Main St')).toBe('12 Main St'); // not valid JSON
    expect(propertyText(['a'])).toBe('["a"]');
    expect(propertyText('x')).toBe('x');
  });
});

describe('Inspector editing', () => {
  let store: GraphStore;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<Inspector>>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Inspector);
    store = TestBed.inject(GraphStore);
    store.reset();
    el = fixture.nativeElement as HTMLElement;
  });

  async function select(): Promise<string> {
    const e = store.upsertEntity({ type: 'Person', value: 'Jane Doe', properties: { age: 41 } }).entity;
    store.select(e.id);
    await fixture.whenStable();
    return e.id;
  }

  it('edits, adds and removes properties as undoable steps', async () => {
    const id = await select();
    const input = el.querySelector<HTMLInputElement>('.prop-value')!;
    input.value = '42';
    input.dispatchEvent(new Event('change'));
    expect(store.entities().get(id)!.properties).toEqual({ age: 42 });
    expect(store.undoLabel()).toBe('Edit age on Jane Doe');

    const [k, v] = [...el.querySelectorAll<HTMLInputElement>('.prop-add input')];
    k.value = 'city';
    v.value = 'Riga';
    el.querySelector<HTMLFormElement>('.prop-add')!.dispatchEvent(new Event('submit'));
    expect(store.entities().get(id)!.properties).toEqual({ age: 42, city: 'Riga' });

    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.icon-x')!.click();
    expect(store.entities().get(id)!.properties).toEqual({ city: 'Riga' });
    store.undo();
    expect(store.entities().get(id)!.properties).toEqual({ age: 42, city: 'Riga' });
  });

  it('enables Add once a property name is typed', async () => {
    const id = await select();
    const [k, v] = [...el.querySelectorAll<HTMLInputElement>('.prop-add input')];
    const add = el.querySelector<HTMLButtonElement>('.prop-add button')!;
    expect(add.disabled).toBe(true);
    k.value = 'city';
    k.dispatchEvent(new Event('input'));
    v.value = 'Riga';
    await fixture.whenStable();
    expect(add.disabled).toBe(false);
    add.click();
    expect(store.entities().get(id)!.properties).toEqual({ age: 41, city: 'Riga' });
    await fixture.whenStable();
    expect(add.disabled).toBe(true);
  });

  it('adds comma-separated tags and removes them', async () => {
    const id = await select();
    const input = el.querySelector<HTMLInputElement>('.tag-input')!;
    input.value = 'suspect, latvia';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(store.entities().get(id)!.tags).toEqual(['suspect', 'latvia']);
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.tag-x')!.click();
    expect(store.entities().get(id)!.tags).toEqual(['latvia']);
  });

  it('edits notes in Markdown and saves with Cmd/Ctrl+Enter', async () => {
    const id = await select();
    el.querySelector<HTMLButtonElement>('.notes-head .small-btn')!.click();
    await fixture.whenStable();
    const ta = el.querySelector<HTMLTextAreaElement>('.notes-editor')!;
    ta.value = '**Confirmed** via LinkedIn';
    ta.dispatchEvent(new Event('input'));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await fixture.whenStable();
    expect(store.entities().get(id)!.notes).toBe('**Confirmed** via LinkedIn');
    expect(el.querySelector('.notes-md strong')?.textContent).toBe('Confirmed');
  });

  it('relabels a link (normalized to snake_case)', async () => {
    const a = store.upsertEntity({ type: 'Person', value: 'Jane' }).entity;
    const b = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
    const edge = store.upsertEdge(a.id, b.id, 'related_to');
    store.selectEdge(edge.id);
    await fixture.whenStable();
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Link label"]')!;
    input.value = 'Works at';
    input.dispatchEvent(new Event('change'));
    expect([...store.edges().values()].map((e) => e.label)).toEqual(['works_at']);
    expect(store.selectedEdge()?.label).toBe('works_at');
  });
});
