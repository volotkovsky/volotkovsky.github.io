import { describe, expect, it } from 'vitest';
import { maxKv } from '../scripts/voltage.ts';

describe('maxKv', () => {
  it('reads a single voltage in volts', () => {
    expect(maxKv('115000')).toBe(115);
    expect(maxKv('13200')).toBe(13.2);
  });

  it('takes the highest of several circuits', () => {
    expect(maxKv('230000;115000')).toBe(230);
    expect(maxKv('115000;34500;13200')).toBe(115);
    expect(maxKv('34500,115000')).toBe(115);
  });

  it('skips unknown parts', () => {
    expect(maxKv('230000;115000;?')).toBe(230);
    expect(maxKv('?;69000')).toBe(69);
    expect(maxKv('115000;medium')).toBe(115);
  });

  it('reads units', () => {
    expect(maxKv('115 kV')).toBe(115);
    expect(maxKv('13.2kV')).toBe(13.2);
    expect(maxKv('230000 V')).toBe(230);
    expect(maxKv('230KV;115kv')).toBe(230);
  });

  it('takes a bare number under 1,000 as kV', () => {
    expect(maxKv('115')).toBe(115);
    expect(maxKv('230;115000')).toBe(230);
  });

  it('gives null when nothing is readable', () => {
    expect(maxKv(undefined)).toBeNull();
    expect(maxKv(null)).toBeNull();
    expect(maxKv('')).toBeNull();
    expect(maxKv('?')).toBeNull();
    expect(maxKv('high;low')).toBeNull();
    expect(maxKv('0')).toBeNull();
    expect(maxKv('-115000')).toBeNull();
  });
});
