import { describe, expect, it } from 'vitest';
import { attendeeLabel } from './attendeeLabel';

describe('attendeeLabel', () => {
  it('names an attendee by the nickname they chose', () => {
    expect(attendeeLabel({ nickname: 'alice', tokenId: '79545075164321394943918126137350' }, 'Guest')).toBe('alice');
  });

  it('falls back to the guest word and the ticket short number when there is no nickname', () => {
    expect(attendeeLabel({ nickname: '', tokenId: '79545075164321394943918126137350' }, 'Guest')).toBe(
      'Guest · 7954…7350',
    );
  });

  it('treats a blank nickname as none, so a cell is never empty', () => {
    expect(attendeeLabel({ nickname: '   ', tokenId: '42' }, 'Guest')).toBe('Guest · 42');
  });
});
