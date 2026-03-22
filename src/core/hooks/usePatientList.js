import { useMemo } from 'react';
import { getModule } from '../moduleRegistry';

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
      list = list.filter(p => {
        const pModules = p.data.activeModules || [];
        return pModules.length > 0 && pModules.every(mId => {
          const mod = getModule(mId);
          const compatData = { shared: p.data.shared, module: p.data.modules?.[mId] || {} };
          return mod?.isComplete?.(compatData) ?? false;
        });
      });
    } else if (statusFilter === 'incomplete') {
      list = list.filter(p => {
        const pModules = p.data.activeModules || [];
        return pModules.length === 0 || !pModules.every(mId => {
          const mod = getModule(mId);
          const compatData = { shared: p.data.shared, module: p.data.modules?.[mId] || {} };
          return mod?.isComplete?.(compatData) ?? false;
        });
      });
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
