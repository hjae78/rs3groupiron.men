import { etagOf } from './etag';

describe('etagOf', () => {
  it('is deterministic for the same body', () => {
    expect(etagOf('abc')).toBe(etagOf('abc'));
  });

  it('differs for different bodies', () => {
    expect(etagOf('abc')).not.toBe(etagOf('abd'));
  });

  it('is quoted', () => {
    expect(etagOf('abc')).toMatch(/^".+"$/);
  });

  it('works on a Buffer the same as on its string form', () => {
    expect(etagOf(Buffer.from('abc'))).toBe(etagOf('abc'));
  });
});
