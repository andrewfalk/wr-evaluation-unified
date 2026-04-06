import { useMemo } from 'react';
import { isPatientComplete } from '../utils/patientCompletion';

export function usePatientList(patients, searchQuery, sortKey, statusFilter) {
  return useMemo(() => {
    let list = patients;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(p => {
        const d = p.data;
        return (d.shared?.name || '').toLowerCase().includes(q)
          || (d.shared?.diagnoses?.[0]?.name || '').toLowerCase().includes(q);
      });
    }

    if (statusFilter === 'complete') {
      list = list.filter(p => isPatientComplete(p));
    } else if (statusFilter === 'incomplete') {
      list = list.filter(p => !isPatientComplete(p));
    }

    if (sortKey === 'name') {
      list = [...list].sort((a, b) => (a.data.shared?.name || '').localeCompare(b.data.shared?.name || '', 'ko'));
    } else if (sortKey === 'birthDate') {
      list = [...list].sort((a, b) => (a.data.shared?.birthDate || '').localeCompare(b.data.shared?.birthDate || ''));
    } else if (sortKey === 'evaluationDate') {
      list = [...list].sort((a, b) => (b.data.shared?.evaluationDate || '').localeCompare(a.data.shared?.evaluationDate || ''));
    }

    return list;
  }, [patients, searchQuery, sortKey, statusFilter]);
}
