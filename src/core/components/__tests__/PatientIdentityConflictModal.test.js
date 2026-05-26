import { describe, expect, it } from 'vitest';
import {
  canShowUseServerButton,
  getIdentityConflictMessage,
  isUseServerActionDisabled,
} from '../PatientIdentityConflictModal.jsx';

describe('getIdentityConflictMessage', () => {
  it('returns the identity-conflict message for PATIENT_IDENTITY_CONFLICT', () => {
    expect(getIdentityConflictMessage('PATIENT_IDENTITY_CONFLICT')).toMatch(/생년월일/);
  });

  it('returns the person-conflict message for PATIENT_PERSON_CONFLICT', () => {
    expect(getIdentityConflictMessage('PATIENT_PERSON_CONFLICT')).toMatch(/이미 조직에 등록/);
  });

  it('returns a generic fallback for unknown codes', () => {
    expect(getIdentityConflictMessage('SOMETHING_ELSE')).toMatch(/등록번호 충돌/);
    expect(getIdentityConflictMessage(undefined)).toMatch(/등록번호 충돌/);
  });
});

describe('canShowUseServerButton', () => {
  it('returns true when the patient has a server id', () => {
    expect(canShowUseServerButton({ sync: { serverId: 'server-1' } })).toBe(true);
  });

  it('returns false when the patient has no server id (first-POST conflict)', () => {
    expect(canShowUseServerButton({ sync: { serverId: null } })).toBe(false);
    expect(canShowUseServerButton({ sync: {} })).toBe(false);
    expect(canShowUseServerButton(null)).toBe(false);
  });
});

describe('isUseServerActionDisabled', () => {
  it('disables the action while loading', () => {
    expect(isUseServerActionDisabled({ serverPatient: null, loading: true, fetchError: '' })).toBe(true);
  });

  it('disables the action when fetch failed', () => {
    expect(isUseServerActionDisabled({
      serverPatient: null,
      loading: false,
      fetchError: 'Could not load',
    })).toBe(true);
  });

  it('disables the action when the server patient has not arrived yet', () => {
    expect(isUseServerActionDisabled({ serverPatient: null, loading: false, fetchError: '' })).toBe(true);
  });

  it('enables the action once the server patient is loaded and no error', () => {
    expect(isUseServerActionDisabled({
      serverPatient: { id: 'server-1' },
      loading: false,
      fetchError: '',
    })).toBe(false);
  });
});
