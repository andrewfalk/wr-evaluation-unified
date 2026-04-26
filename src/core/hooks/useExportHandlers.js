import { useState, useEffect } from 'react';
import { showAlert } from '../utils/platform';

export function useExportHandlers({ activePatient, patients, selectedIds }) {
  const [exportDropdown, setExportDropdown] = useState(null);

  useEffect(() => {
    if (!exportDropdown) return;
    const close = () => setExportDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [exportDropdown]);

  const handleExportSingle = async () => {
    if (!activePatient) return;
    try {
      const { exportSingle } = await import('../utils/exportService');
      exportSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportSelected = async () => {
    try {
      const { exportSelected } = await import('../utils/exportService');
      await exportSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatch = async () => {
    try {
      const { exportBatch } = await import('../utils/exportService');
      await exportBatch(patients);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSingle = async () => {
    if (!activePatient) return;
    try {
      const { exportBatchFormatSingle } = await import('../utils/exportService');
      exportBatchFormatSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSelected = async () => {
    try {
      const { exportBatchFormatSelected } = await import('../utils/exportService');
      await exportBatchFormatSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatAll = async () => {
    try {
      const { exportBatchFormatAll } = await import('../utils/exportService');
      await exportBatchFormatAll(patients);
    } catch (err) { await showAlert(err.message); }
  };

  return {
    exportDropdown,
    setExportDropdown,
    handleExportSingle,
    handleExportSelected,
    handleExportBatch,
    handleExportBatchFormatSingle,
    handleExportBatchFormatSelected,
    handleExportBatchFormatAll,
  };
}
