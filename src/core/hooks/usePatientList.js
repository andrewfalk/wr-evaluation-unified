import { useMemo } from 'react';
import { isPatientComplete } from '../utils/patientCompletion';
import { isRedactedPatientRecord } from '../services/patientRecords';
import { toLocalDateString } from '../utils/common';

const DEFAULT_FILTERS = {
  searchQuery: '',
  statusFilter: 'all',
  moduleFilter: 'all',
  // jobFilter는 직종명 자유 입력(부분 일치)이라 "전체"는 빈 문자열이다 — 'all'은 모듈 필터 표기를 잘못 옮긴 값으로,
  // filters를 생략하면 "직종명에 all이 든 환자만" 남기는 잠복 버그였다(P2-28, flagged). App은 ''을 넘겨 드러나지 않았다.
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
  sortKey: 'default',
  sortDirection: 'asc',
};

const numericCollator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function includesQuery(value, query) {
  return String(value || '').toLowerCase().includes(query);
}

function getShared(patient) {
  return patient?.data?.shared || {};
}

function getRegistrationDate(patient) {
  return toLocalDateString(patient?.createdAt || patient?._savedAt || '');
}

function inDateRange(dateValue, from, to) {
  if (!from && !to) return true;
  if (!dateValue) return false;
  if (from && dateValue < from) return false;
  if (to && dateValue > to) return false;
  return true;
}

function comparePatients(a, b, sortKey) {
  const sharedA = getShared(a);
  const sharedB = getShared(b);

  if (sortKey === 'name') {
    return (sharedA.name || '').localeCompare(sharedB.name || '', 'ko');
  }
  if (sortKey === 'patientNo') {
    return numericCollator.compare(sharedA.patientNo || '', sharedB.patientNo || '');
  }
  if (sortKey === 'birthDate') {
    return (sharedA.birthDate || '').localeCompare(sharedB.birthDate || '');
  }
  if (sortKey === 'registrationDate') {
    return getRegistrationDate(a).localeCompare(getRegistrationDate(b));
  }
  if (sortKey === 'evaluationDate') {
    return (sharedA.evaluationDate || '').localeCompare(sharedB.evaluationDate || '');
  }
  return 0;
}

export function filterPatients(patients, filters = DEFAULT_FILTERS) {
  const {
    searchQuery = '',
    statusFilter = 'all',
    moduleFilter = 'all',
    jobFilter = '',
    registrationFrom = '',
    registrationTo = '',
    completionFrom = '',
    completionTo = '',
    sortKey = 'default',
    sortDirection = 'asc',
  } = filters || {};

  let list = (patients || []).filter(patient => !isRedactedPatientRecord(patient));

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(p => {
      const shared = getShared(p);
      const diagnoses = shared.diagnoses || [];
      const jobs = shared.jobs || [];

      return includesQuery(shared.name, q)
        || includesQuery(shared.patientNo, q)
        || diagnoses.some(d => includesQuery(d.name, q) || includesQuery(d.code, q))
        || jobs.some(j => includesQuery(j.jobName, q));
    });
  }

  if (statusFilter === 'complete') {
    list = list.filter(p => isPatientComplete(p));
  } else if (statusFilter === 'incomplete') {
    list = list.filter(p => !isPatientComplete(p));
  }

  if (moduleFilter !== 'all') {
    list = list.filter(p => (p.data?.activeModules || []).includes(moduleFilter));
  }

  if (jobFilter.trim()) {
    const jq = jobFilter.trim().toLowerCase();
    list = list.filter(p => (getShared(p).jobs || []).some(job => includesQuery(job.jobName, jq)));
  }

  if (registrationFrom || registrationTo) {
    list = list.filter(p => inDateRange(getRegistrationDate(p), registrationFrom, registrationTo));
  }

  if (completionFrom || completionTo) {
    list = list.filter(p => inDateRange(getShared(p).evaluationDate || '', completionFrom, completionTo));
  }

  if (sortKey === 'default') {
    if (sortDirection === 'desc') list = [...list].reverse();
  } else {
    const direction = sortDirection === 'desc' ? -1 : 1;
    list = [...list].sort((a, b) => comparePatients(a, b, sortKey) * direction);
  }

  return list;
}

export function usePatientList(patients, filters = DEFAULT_FILTERS) {
  return useMemo(() => filterPatients(patients, filters), [patients, filters]);
}
