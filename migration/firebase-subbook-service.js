// Atomic Firestore service for sub_books + sub_book_logs.
(function () {
  'use strict';

  window.firebaseSubBookServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    function id(prefix) {
      return (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function asTimestamp(value) {
      if (value === null || value === undefined) return value;
      if (typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      return value;
    }

    function makeLog(subBookId, log, actor) {
      const now = new Date().toISOString();
      return {
        id: id('sblog'),
        sub_book_id: String(subBookId),
        action_type: log.action_type,
        quantity: Number(log.quantity || 0),
        action_date: asTimestamp(log.action_date || now),
        user_name: actor?.name || '',
        user_role: actor?.role || '',
        notes: log.notes || '',
        created_at: asTimestamp(now)
      };
    }

    async function insertSubBook({ subBook, actor }) {
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const now = new Date().toISOString();
      const subBookId = subBook.id || ('sb_' + id('book'));
      const data = {
        ...subBook,
        id: subBookId,
        stock_quantity: Number(subBook.stock_quantity || 0),
        released_quantity: Number(subBook.released_quantity || 0),
        created_by: subBook.created_by || actor.name,
        updated_by: actor.name,
        created_at: asTimestamp(subBook.created_at || now),
        updated_at: asTimestamp(now)
      };
      await fs.setDoc(fs.doc(db, 'sub_books', String(subBookId)), data);
      return { subBookId };
    }

    async function updateSubBookWithLog({ subBookId, expectedStock, expectedReleased, updates, log, actor }) {
      if (!subBookId) throw new Error('subBookId가 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const bookRef = fs.doc(db, 'sub_books', String(subBookId));
      const logData = makeLog(subBookId, log, actor);
      const logRef = fs.doc(db, 'sub_book_logs', logData.id);
      const now = new Date().toISOString();

      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(bookRef);
        if (!snap.exists()) throw new Error('대상 부교재가 존재하지 않습니다.');
        const current = snap.data();
        const stock = Number(current.stock_quantity || 0);
        const released = Number(current.released_quantity || 0);
        if (expectedStock !== undefined && Number(expectedStock) !== stock) {
          const err = new Error(`부교재 입고량이 변경되었습니다. 현재=${stock}, 예상=${expectedStock}`);
          err.code = 'mg/conflict-subbook-stock';
          throw err;
        }
        if (expectedReleased !== undefined && Number(expectedReleased) !== released) {
          const err = new Error(`부교재 출고량이 변경되었습니다. 현재=${released}, 예상=${expectedReleased}`);
          err.code = 'mg/conflict-subbook-release';
          throw err;
        }
        const convertedUpdates = { ...updates, updated_by: actor.name, updated_at: asTimestamp(now) };
        tx.update(bookRef, convertedUpdates);
        tx.set(logRef, logData);
      });
      return { logId: logData.id };
    }

    async function deleteSubBookWithLogs({ subBookId }) {
      if (!subBookId) throw new Error('subBookId가 없습니다.');
      const bookRef = fs.doc(db, 'sub_books', String(subBookId));
      const logsSnap = await fs.getDocs(fs.query(
        fs.collection(db, 'sub_book_logs'),
        fs.where('sub_book_id', '==', String(subBookId))
      ));
      if (logsSnap.size > 450) throw new Error('부교재 로그가 너무 많아 한 번에 삭제할 수 없습니다. 관리자 정리가 필요합니다.');
      const batch = fs.writeBatch(db);
      batch.delete(bookRef);
      logsSnap.forEach(d => batch.delete(d.ref));
      await batch.commit();
      return { deletedLogs: logsSnap.size };
    }

    const service = { insertSubBook, updateSubBookWithLog, deleteSubBookWithLogs };
    window.firebaseSubBookService = service;
    return service;
  })();
})();
