import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('creates the shell', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders all four panes', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    for (const sel of ['app-palette', 'app-canvas', 'app-inspector', 'app-console']) {
      expect(el.querySelector(sel)).not.toBeNull();
    }
  });

  it('lists all 14 entity types in the palette', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const items = (fixture.nativeElement as HTMLElement).querySelectorAll('.palette-item');
    expect(items.length).toBe(14);
  });

  it('has a File menu with New / Open / Save / Save As', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const triggers = [...el.querySelectorAll<HTMLButtonElement>('.menu-trigger')];
    expect(triggers.map((b) => b.textContent?.trim())).toEqual(['File', 'Edit', 'View', 'Help']);
    triggers[0].click();
    fixture.detectChanges();
    const items = [...el.querySelectorAll('.menu-dropdown button span:first-child')].map((s) => s.textContent?.trim());
    expect(items).toEqual(['New investigation', 'Open…', 'Save', 'Save As…', 'Settings…']);
  });

  it('switches the right panel between Inspector and AI Chat', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('.tab')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Inspector', 'AI Chat']);
    const bodies = () => [...el.querySelectorAll<HTMLElement>('.tab-body')].map((b) => b.hidden);
    expect(bodies()).toEqual([false, true]);
    tabs[1].click();
    await fixture.whenStable();
    expect(bodies()).toEqual([true, false]);
    expect(el.querySelector('app-chat textarea')).not.toBeNull();
  });

  it('Help > About opens a dialog with the app name and a GitHub link', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.menu-trigger')[3].click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.menu-dropdown button')!.click();
    await fixture.whenStable();
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe('libreOSINT');
    expect(dialog.querySelector('a')?.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
    dialog.querySelector<HTMLButtonElement>('button')!.click();
    await fixture.whenStable();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('File > Settings sets a lookup proxy and shows a "via proxy" badge', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.net-badge')).toBeNull();
    el.querySelectorAll<HTMLButtonElement>('.menu-trigger')[0].click();
    await fixture.whenStable();
    [...el.querySelectorAll<HTMLButtonElement>('.menu-dropdown button')].find((b) => b.textContent?.includes('Settings'))!.click();
    await fixture.whenStable();
    el.querySelector<HTMLInputElement>('input[type="radio"][value="custom"]')!.click();
    await fixture.whenStable();
    // Proxy mode without a URL is flagged, never silently direct.
    expect(el.querySelector('.net-badge')?.textContent?.trim()).toBe('⚠ no proxy URL');
    const url = el.querySelector<HTMLInputElement>('input[aria-label="Proxy URL"]')!;
    url.value = 'socks5h://user:s3cret@127.0.0.1:1080';
    url.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const badge = el.querySelector<HTMLElement>('.net-badge')!;
    expect(badge.textContent?.trim()).toBe('● via proxy');
    expect(badge.title).toContain('socks5h://127.0.0.1:1080');
    expect(badge.title).not.toContain('s3cret');
    el.querySelector<HTMLInputElement>('input[type="radio"][value="direct"]')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.net-badge')).toBeNull();
  });
});
