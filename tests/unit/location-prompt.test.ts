/**
 * The location setting and how it reaches a check (NEWS-393, `docs/35-location.md`).
 *
 * The prompt assertions are the point. FR-35.4 deliberately has no stored
 * per-topic scope — the whole feature is one instruction in the user prompt — so
 * these tests are the only thing standing between a refactor and a location that
 * is set, stored, displayed, and silently never asked about.
 */

import { describe, expect, it } from 'vitest';

import { buildUserPrompt } from '../../src/ai/prompt.js';
import { UpdateSettingsReqSchema } from '../../src/api/schemas.js';
import { SettingsSchema } from '../../src/db/schemas.js';

describe('location in the check prompt', () => {
  it('states where the user is when one is set', () => {
    const prompt = buildUserPrompt('Concerts', [], null, { location: 'Lisbon' });
    expect(prompt).toContain('The user is in: Lisbon.');
  });

  it('says nothing at all when no location is set', () => {
    // Not "the user is in: (unset)" — an absent location must leave the prompt
    // byte-identical to what it was before the feature, or every existing
    // topic's behaviour changes on upgrade.
    for (const location of [undefined, '', '   ']) {
      const prompt = buildUserPrompt('Space exploration', [], null, location === undefined ? {} : { location });
      expect(prompt).not.toContain('The user is in');
      expect(prompt.toLowerCase()).not.toContain('user is in');
    }
  });

  it('tells the model to ignore it for subjects that are not about a place', () => {
    // FR-35.5. Without this half the location leaks into every topic and a
    // global subject quietly goes local — which is worse than not having the
    // feature, because the user cannot see why the topic went quiet.
    const prompt = buildUserPrompt('Space exploration', [], null, { location: 'Lisbon' });
    expect(prompt).toContain('ignore it entirely and search globally');
  });

  it('leaves the breadth to the model rather than fixing a radius', () => {
    // FR-35.4: no stored scope, so the prompt must say the breadth varies.
    const prompt = buildUserPrompt('Elections', [], null, { location: 'Lisbon' });
    expect(prompt).toContain('judge the right breadth yourself');
  });

  it('passes a non-Latin location through unaltered', () => {
    // FR-35.2. The failure this guards against is a well-meaning normalise or
    // slugify step somewhere in the chain turning 東京 into "" or "dong-jing".
    const prompt = buildUserPrompt('コンサート', [], null, { location: '東京' });
    expect(prompt).toContain('The user is in: 東京.');
  });

  it('never puts the location in the topic name', () => {
    // FR-35.7. Appending it to the name would make normalizeTopicName treat the
    // topic as a different subject and break dedup against everything already
    // reported.
    const prompt = buildUserPrompt('Concerts', [], null, { location: 'Lisbon' });
    expect(prompt).toContain('Topic: Concerts\n');
    expect(prompt).not.toContain('Topic: Concerts in Lisbon');
    expect(prompt).not.toContain('Topic: Concerts (Lisbon)');
  });

  it('keeps the location alongside guidance rather than replacing it', () => {
    // Both are steers and both must survive — an early version could plausibly
    // have made one an else-branch of the other.
    const prompt = buildUserPrompt('Concerts', [], null, {
      location: 'Lisbon',
      guidance: 'Venue announcements only, not reviews.',
    });
    expect(prompt).toContain('The user is in: Lisbon.');
    expect(prompt).toContain('Venue announcements only, not reviews.');
  });
});

describe('the location setting', () => {
  it('defaults to empty, which means global', () => {
    const settings = SettingsSchema.parse({ checkIntervalMs: 86_400_000 });
    expect(settings.location).toBe('');
  });

  it('round-trips a value in a non-Latin script through the request schema', () => {
    const parsed = UpdateSettingsReqSchema.parse({ location: '北海道' });
    expect(parsed.location).toBe('北海道');
  });

  it('accepts a whole continent and a bare clearing value', () => {
    // FR-35.3 — granularity is the user's choice, and '' is how you opt out.
    expect(UpdateSettingsReqSchema.parse({ location: 'Europe' }).location).toBe('Europe');
    expect(UpdateSettingsReqSchema.parse({ location: '' }).location).toBe('');
  });

  it('caps the length but does not otherwise validate the string', () => {
    // FR-35.2: there is nothing to validate against, so the only rule is a
    // sanity bound. A place name with punctuation and spaces must pass.
    expect(UpdateSettingsReqSchema.parse({ location: "Stratford-upon-Avon, Warwickshire" }).location).toBe(
      "Stratford-upon-Avon, Warwickshire",
    );
    expect(UpdateSettingsReqSchema.safeParse({ location: 'x'.repeat(200) }).success).toBe(true);
    expect(UpdateSettingsReqSchema.safeParse({ location: 'x'.repeat(201) }).success).toBe(false);
  });

  it('survives a stored row that predates the field', () => {
    // Pre-launch, but the same zod-on-read rule applies to any row written by an
    // older build: a missing location must default rather than reject the whole
    // settings object and reset every other preference with it.
    const settings = SettingsSchema.parse({ checkIntervalMs: 86_400_000, theme: 'dark', backupDir: '/tmp/x' });
    expect(settings.location).toBe('');
    expect(settings.theme).toBe('dark');
    expect(settings.backupDir).toBe('/tmp/x');
  });
});
