export function SaveModal({ patientCount, saveName, onSaveNameChange, savedItems, onSave, onOverwriteSave, onDelete, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal save-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>저장</h2>
            <p className="modal-section-description">현재 {patientCount}명의 환자 데이터를 저장합니다.</p>
          </div>
        </div>
        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">새 저장</h3>
              <p className="modal-section-description">저장명을 입력해 새 항목으로 보관합니다.</p>
            </div>
          </div>
          <div className="form-group">
            <label>저장명</label>
            <input value={saveName} onChange={onSaveNameChange} autoFocus />
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={onSave}>새로 저장</button>
            <button className="btn btn-secondary" onClick={onClose}>취소</button>
          </div>
        </section>
        {savedItems.length > 0 && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">기존 저장 목록</h3>
                <p className="modal-section-description">기존 항목을 선택해 바로 덮어쓸 수 있습니다.</p>
              </div>
              <span className="modal-section-badge">{savedItems.length}개</span>
            </div>
            <div className="modal-scroll-list">
              {savedItems.map(item => (
                <div key={item.id} className="saved-item">
                  <div className="saved-item-content">
                    <h4>{item.name}</h4>
                    <p>{item.count || 1}명 | {new Date(item.savedAt).toLocaleString('ko-KR')}</p>
                  </div>
                  <div className="saved-item-actions">
                    <button className="btn btn-primary btn-xs" onClick={() => onOverwriteSave(item)}>덮어쓰기</button>
                    <button className="btn btn-danger btn-xs" onClick={() => onDelete(item.id)}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function LoadModal({ legacyItems, savedItems, onLoad, onDelete, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal load-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>불러오기</h2>
            <p className="modal-section-description">저장된 데이터를 덮어쓰거나 현재 목록에 추가할 수 있습니다.</p>
          </div>
          <span className="modal-section-badge">
            {(legacyItems?.length || 0) + savedItems.length}개 항목
          </span>
        </div>

        {legacyItems && legacyItems.length > 0 && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">이전 프로그램(무릎) 데이터</h3>
                <p className="modal-section-description">레거시 저장본을 현재 통합 포맷으로 불러옵니다.</p>
              </div>
              <span className="modal-section-badge">{legacyItems.length}개</span>
            </div>
            {legacyItems.map((item, idx) => (
              <div key={`legacy-${idx}`} className="saved-item saved-item-legacy">
                <div className="saved-item-content">
                  <h4>{item.name}</h4>
                  <p>{item.count || item.patients?.length || 0}명 | {item.savedAt ? new Date(item.savedAt).toLocaleString('ko-KR') : '-'}</p>
                </div>
                <div className="saved-item-actions">
                  <button className="btn btn-primary btn-xs" onClick={() => onLoad(item, 'overwrite')}>덮어쓰기</button>
                  <button className="btn btn-info btn-xs" onClick={() => onLoad(item, 'append')}>추가</button>
                </div>
              </div>
            ))}
          </section>
        )}

        {savedItems.length === 0 && (!legacyItems || legacyItems.length === 0) ? (
          <div className="modal-empty-state">저장 데이터 없음</div>
        ) : (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">통합 프로그램 저장 데이터</h3>
                <p className="modal-section-description">현재 앱에서 저장한 환자 데이터입니다.</p>
              </div>
              <span className="modal-section-badge">{savedItems.length}개</span>
            </div>
            {savedItems.map(item => (
              <div key={item.id} className="saved-item">
                <div className="saved-item-content">
                  <h4>{item.name}</h4>
                  <p>{item.count || 1}명 | {new Date(item.savedAt).toLocaleString('ko-KR')}</p>
                </div>
                <div className="saved-item-actions">
                  <button className="btn btn-primary btn-xs" onClick={() => onLoad(item, 'overwrite')}>덮어쓰기</button>
                  <button className="btn btn-info btn-xs" onClick={() => onLoad(item, 'append')}>추가</button>
                  <button className="btn btn-danger btn-xs" onClick={() => onDelete(item.id)}>삭제</button>
                </div>
              </div>
            ))}
          </section>
        )}
        <div className="modal-actions modal-actions-stretch">
          <button className="btn btn-secondary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
