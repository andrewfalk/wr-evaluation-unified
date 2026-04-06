import { getModule } from '../moduleRegistry';

export function isPatientComplete(patient) {
  const moduleIds = patient?.data?.activeModules || [];
  if (moduleIds.length === 0) return false;

  return moduleIds.every(moduleId => {
    try {
      const mod = getModule(moduleId);
      return mod?.isComplete?.({
        shared: patient?.data?.shared,
        module: patient?.data?.modules?.[moduleId] || {},
      }) ?? false;
    } catch {
      return false;
    }
  });
}

export function getLocalDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getSyncedEvaluationDate(patient, today = new Date()) {
  const current = patient?.data?.shared?.evaluationDate || '';
  if (isPatientComplete(patient)) return current || getLocalDateString(today);
  return '';
}
