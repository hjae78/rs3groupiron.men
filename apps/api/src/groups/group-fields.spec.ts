import { verifiedCount } from './group-fields';

describe('verifiedCount', () => {
  it('counts only plugin_verified members', () => {
    expect(
      verifiedCount([
        { name: 'A', player: { verificationStatus: 'plugin_verified' } },
        { name: 'B', player: { verificationStatus: 'unverified' } },
        { name: 'C', player: null },
      ]),
    ).toBe(1);
  });

  it('excludes the shared pseudo-member even if somehow verified', () => {
    expect(
      verifiedCount([
        { name: '@SHARED', player: { verificationStatus: 'plugin_verified' } },
      ]),
    ).toBe(0);
  });

  it('is zero for an all-unverified group', () => {
    expect(
      verifiedCount([
        { name: 'A', player: null },
        { name: 'B', player: { verificationStatus: 'unverified' } },
      ]),
    ).toBe(0);
  });
});
