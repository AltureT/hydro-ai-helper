import {
  parseSemver,
  normalizeVersion,
  isNewerVersion,
  isStableVersionTag,
  pickLatestStableTag
} from '../../utils/semver';

describe('semver util', () => {
  describe('parseSemver', () => {
    it('parses plain versions', () => {
      expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
    });
    it('strips v prefix and prerelease suffix', () => {
      expect(parseSemver('v2.0.0')).toEqual([2, 0, 0]);
      expect(parseSemver('v2.3.0-beta.1')).toEqual([2, 3, 0]);
    });
    it('defaults missing parts to 0', () => {
      expect(parseSemver('1')).toEqual([1, 0, 0]);
      expect(parseSemver('')).toEqual([0, 0, 0]);
    });
  });

  describe('normalizeVersion', () => {
    it('removes leading v/V and trims', () => {
      expect(normalizeVersion('v2.2.0')).toBe('2.2.0');
      expect(normalizeVersion('  V1.0.0 ')).toBe('1.0.0');
      expect(normalizeVersion('2.2.0')).toBe('2.2.0');
    });
  });

  describe('isNewerVersion', () => {
    it('compares by major, minor, patch', () => {
      expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
      expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
      expect(isNewerVersion('1.2.4', '1.2.3')).toBe(true);
    });
    it('returns false for equal or older', () => {
      expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
      expect(isNewerVersion('1.2.3', '1.2.4')).toBe(false);
    });
    it('ignores v prefix on both sides', () => {
      expect(isNewerVersion('v2.2.0', '2.1.0')).toBe(true);
    });
  });

  describe('isStableVersionTag', () => {
    it('accepts pure three-part versions with optional v', () => {
      expect(isStableVersionTag('v1.2.3')).toBe(true);
      expect(isStableVersionTag('1.2.3')).toBe(true);
    });
    it('rejects prereleases and junk', () => {
      expect(isStableVersionTag('v2.3.0-beta.1')).toBe(false);
      expect(isStableVersionTag('latest')).toBe(false);
      expect(isStableVersionTag('v1.2')).toBe(false);
      expect(isStableVersionTag('')).toBe(false);
    });
  });

  describe('pickLatestStableTag', () => {
    it('picks the highest stable tag, ignoring prereleases', () => {
      const tags = ['v1.0.0', 'v2.2.0', 'v2.3.0-beta.1', 'v2.1.0', 'nightly'];
      expect(pickLatestStableTag(tags)).toBe('v2.2.0');
    });
    it('returns null when there is no stable tag', () => {
      expect(pickLatestStableTag(['v2.3.0-beta.1', 'random'])).toBeNull();
      expect(pickLatestStableTag([])).toBeNull();
    });
    it('handles mixed v-prefixed and bare tags', () => {
      expect(pickLatestStableTag(['1.0.0', 'v1.5.0', '1.2.0'])).toBe('v1.5.0');
    });
  });
});
