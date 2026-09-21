import { describe, expect, it } from 'vitest';

import * as C from './constants';

describe('staff constants match the spec parameter table (§7.3, §11)', () => {
  it('pins the HCE and NDEF identifiers', () => {
    expect(C.MONTI_AID).toBe('D2760000850101');
    expect(C.NDEF_TYPE_GATE).toBe('monti.app:g');
    expect(C.NDEF_TYPE_RESPONSE).toBe('monti.app:s');
    expect(C.QR_PREFIX).toBe('MONTI1:');
  });

  it('pins the timing parameters', () => {
    expect(C.GATE_CODE_ROTATE_MS).toBe(3000);
    expect(C.CODE_WINDOW_SECONDS).toBe(60);
    expect(C.SNAPSHOT_REFRESH_MS).toBe(600_000);
    expect(C.CONFIRM_SPINNER_MS).toBe(2000);
    expect(C.RETAP_PROMPT_MS).toBe(5000);
  });

  it('keeps the gate key alias distinct from the attendee device key', () => {
    expect(C.GATE_KEY_ALIAS).toBe('monti-gate');
  });

  it('names the staff device database', () => {
    expect(C.STAFF_DB_NAME).toBe('monti-staff');
    expect(C.STAFF_DB_VERSION).toBe(1);
  });
});
