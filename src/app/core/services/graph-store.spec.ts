import { TestBed } from '@angular/core/testing';
import { GraphStore } from './graph-store';
import { InvalidValueError } from '../models/normalize';

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = TestBed.inject(GraphStore);
    store.reset();
  });

  it('creates a new entity with defaults and marks the case dirty', () => {
    const { entity, created } = store.upsertEntity({ type: 'Domain', value: ' example.com ' }, { x: 10, y: 20 });
    expect(created).toBe(true);
    expect(entity.value).toBe('example.com');
    expect(entity.notes).toBe('');
    expect(store.positions().get(entity.id)).toEqual({ x: 10, y: 20 });
    expect(store.dirty()).toBe(true);
  });

  it('dedups on (type, normalized value) and merges properties and tags', () => {
    const a = store.upsertEntity({ type: 'Domain', value: 'Example.com', properties: { a: 1, b: 1 }, tags: ['x'] });
    const b = store.upsertEntity({ type: 'Domain', value: 'example.com.', properties: { b: 2, c: 3 }, tags: ['x', 'y'] });
    expect(b.created).toBe(false);
    expect(b.entity.id).toBe(a.entity.id);
    expect(b.entity.value).toBe('Example.com'); // first-seen spelling kept
    expect(b.entity.properties).toEqual({ a: 1, b: 2, c: 3 }); // incoming wins
    expect(b.entity.tags).toEqual(['x', 'y']);
    expect(store.counts().entities).toBe(1);
  });

  it('keeps the same value under different types separate', () => {
    store.upsertEntity({ type: 'Domain', value: 'example.com' });
    store.upsertEntity({ type: 'Subdomain', value: 'example.com' });
    expect(store.counts().entities).toBe(2);
  });

  it('rejects invalid values without changing state', () => {
    expect(() => store.upsertEntity({ type: 'IPv4', value: '999.0.0.1' })).toThrow(InvalidValueError);
    expect(store.counts().entities).toBe(0);
    expect(store.dirty()).toBe(false);
  });

  it('dedups edges on (source, target, label) and refreshes transform_source', () => {
    const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }).entity;
    const ip = store.upsertEntity({ type: 'IPv4', value: '192.0.2.1' }).entity;
    const e1 = store.upsertEdge(d.id, ip.id, 'resolves_to', 'manual');
    const e2 = store.upsertEdge(d.id, ip.id, 'resolves_to', 'domain_to_dns');
    expect(e2.id).toBe(e1.id);
    expect(store.counts().edges).toBe(1);
    expect(store.edges().get(e1.id)?.transform_source).toBe('domain_to_dns');
    store.upsertEdge(d.id, ip.id, 'related_to');
    expect(store.counts().edges).toBe(2);
  });

  it('removing an entity cascades its edges, position and selection', () => {
    const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }, { x: 0, y: 0 }).entity;
    const ip = store.upsertEntity({ type: 'IPv4', value: '192.0.2.1' }).entity;
    store.upsertEdge(d.id, ip.id, 'resolves_to');
    store.select(d.id);
    store.removeEntities([d.id]);
    expect(store.counts()).toEqual({ entities: 1, edges: 0 });
    expect(store.positions().has(d.id)).toBe(false);
    expect(store.selected()).toBeNull();
  });

  it('round-trips through snapshot/load and clears dirty', () => {
    const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }, { x: 5, y: 6 }).entity;
    const ip = store.upsertEntity({ type: 'IPv4', value: '192.0.2.1' }).entity;
    store.upsertEdge(d.id, ip.id, 'resolves_to');
    store.caseName.set('ACME recon');
    const snap = store.snapshot();

    store.reset();
    expect(store.counts().entities).toBe(0);

    store.load(snap);
    expect(store.counts()).toEqual({ entities: 2, edges: 1 });
    expect(store.positions().get(d.id)).toEqual({ x: 5, y: 6 });
    expect(store.caseName()).toBe('ACME recon');
    expect(store.dirty()).toBe(false);
    // Dedup index is rebuilt after load.
    expect(store.upsertEntity({ type: 'Domain', value: 'EXAMPLE.com' }).created).toBe(false);
  });

  it('refuses snapshots from a newer format version', () => {
    const snap = { ...store.snapshot(), version: 99 };
    expect(() => store.load(snap)).toThrow(/newer/);
  });

  it('one organization can link to many people; links are listed per entity', () => {
    const org = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
    const people = ['Alice', 'Bob', 'Carol'].map((v) => store.upsertEntity({ type: 'Person', value: v }).entity);
    for (const p of people) store.upsertEdge(p.id, org.id, 'works_at');
    expect(store.linksOf(org.id).incoming.map((e) => e.source_id)).toEqual(people.map((p) => p.id));
    expect(store.linksOf(people[0].id).outgoing).toHaveLength(1);
  });

  it('dedups social accounts across URL spellings and derives platform/handle', () => {
    const a = store.upsertEntity({ type: 'Social_Account', value: 'https://twitter.com/JDoe/' });
    expect(a.entity.properties).toEqual({ platform: 'X', handle: 'jdoe', profile_url: 'https://x.com/jdoe' });
    expect(store.upsertEntity({ type: 'Social_Account', value: 'x.com/jdoe' }).created).toBe(false);
    const person = store.upsertEntity({ type: 'Person', value: 'Jane Doe' }).entity;
    store.upsertEdge(person.id, a.entity.id, 'has_account');
    expect(store.linksOf(person.id).outgoing[0].target_id).toBe(a.entity.id);
  });

  it('derives properties for coordinates and stores canonical phone numbers', () => {
    expect(store.upsertEntity({ type: 'Location', value: '56.9496, 24.1052' }).entity.properties).toEqual({
      kind: 'coordinates',
      latitude: 56.9496,
      longitude: 24.1052,
    });
    expect(store.upsertEntity({ type: 'Location', value: 'Riga, Latvia' }).entity.properties).toEqual({});
    const phone = store.upsertEntity({ type: 'Phone_Number', value: '+371 2000 0000' });
    expect(phone.created).toBe(true);
    expect(phone.entity.value).toBe('+37120000000'); // canonical form is stored for phone numbers
    expect(store.upsertEntity({ type: 'Phone_Number', value: '0037120000000' }).created).toBe(false);
  });

  it('rejects self-links', () => {
    const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }).entity;
    expect(() => store.upsertEdge(d.id, d.id, 'related_to')).toThrow(/itself/);
  });

  it('entity and edge selection are mutually exclusive; removing the edge clears it', () => {
    const a = store.upsertEntity({ type: 'Person', value: 'Alice' }).entity;
    const b = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
    const e = store.upsertEdge(a.id, b.id, 'works_at');
    store.select(a.id);
    store.selectEdge(e.id);
    expect(store.selected()).toBeNull();
    expect(store.selectedEdge()?.id).toBe(e.id);
    store.select(b.id);
    expect(store.selectedEdge()).toBeNull();
    store.selectEdge(e.id);
    store.removeEdge(e.id);
    expect(store.selectedEdge()).toBeNull();
    expect(store.counts().edges).toBe(0);
  });

  describe('undo / redo', () => {
    it('undoes and redoes single steps with readable labels', () => {
      const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }, { x: 1, y: 2 }).entity;
      expect(store.undoLabel()).toBe('Add Domain example.com');
      store.updateEntity(d.id, { notes: 'hi' });
      expect(store.undoLabel()).toBe('Edit example.com');

      expect(store.undo()).toBe(true);
      expect(store.entities().get(d.id)!.notes).toBe('');
      expect(store.redoLabel()).toBe('Edit example.com');
      expect(store.undo()).toBe(true);
      expect(store.counts().entities).toBe(0);
      expect(store.positions().size).toBe(0); // the position came with the add: one step
      expect(store.undo()).toBe(false);

      expect(store.redo()).toBe(true);
      expect(store.entities().get(d.id)!.value).toBe('example.com');
      expect(store.positions().get(d.id)).toEqual({ x: 1, y: 2 });
      expect(store.redo()).toBe(true);
      expect(store.entities().get(d.id)!.notes).toBe('hi');
      expect(store.redoLabel()).toBeNull();
    });

    it('groups many changes (a lookup, an AI turn) into one step and skips empty groups', () => {
      store.upsertEntity({ type: 'Domain', value: 'example.com' });
      store.group('Lookup domain_to_dns', () => {
        const d = [...store.entities().values()][0];
        for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
          const e = store.upsertEntity({ type: 'IPv4', value: ip }).entity;
          store.upsertEdge(d.id, e.id, 'resolves_to');
        }
      });
      store.group('Nothing', () => undefined);
      expect(store.undoLabel()).toBe('Lookup domain_to_dns');
      expect(store.counts()).toEqual({ entities: 4, edges: 3 });
      store.undo();
      expect(store.counts()).toEqual({ entities: 1, edges: 0 });
    });

    it('async groups (begin/end) capture everything in between', () => {
      store.beginGroup('AI: map ACME');
      const a = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
      const b = store.upsertEntity({ type: 'Person', value: 'Jane' }).entity;
      store.upsertEdge(a.id, b.id, 'employs');
      store.endGroup();
      expect(store.undoLabel()).toBe('AI: map ACME');
      store.undo();
      expect(store.counts()).toEqual({ entities: 0, edges: 0 });
    });

    it('undo restores deleted entities with their links, and clears stale selection', () => {
      const a = store.upsertEntity({ type: 'Person', value: 'Jane' }).entity;
      const b = store.upsertEntity({ type: 'Email', value: 'jane@example.com' }).entity;
      store.upsertEdge(a.id, b.id, 'uses_email');
      store.removeEntities([a.id]);
      expect(store.counts()).toEqual({ entities: 1, edges: 0 });
      store.undo();
      expect(store.counts()).toEqual({ entities: 2, edges: 1 });
      store.select(a.id);
      store.undo(); // undo the link
      store.undo(); // undo adding the email
      store.undo(); // undo adding Jane
      expect(store.selected()).toBeNull();
    });

    it('a new change clears redo; automatic placement is not an undo step; load clears history', () => {
      const d = store.upsertEntity({ type: 'Domain', value: 'example.com' }).entity;
      store.setPosition(d.id, { x: 5, y: 5 }, { history: false });
      expect(store.undoLabel()).toBe('Add Domain example.com');
      store.setPosition(d.id, { x: 9, y: 9 });
      expect(store.undoLabel()).toBe('Move');
      store.undo();
      expect(store.redoLabel()).toBe('Move');
      store.upsertEntity({ type: 'Domain', value: 'other.example' });
      expect(store.redoLabel()).toBeNull();
      store.load(store.snapshot());
      expect([store.undoLabel(), store.redoLabel()]).toEqual([null, null]);
    });
  });
});
