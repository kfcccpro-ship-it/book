// Atomic write service for MG textbook inventory Firebase migration.
// Keeps course mutations and work_logs creation in one Firestore transaction.
(function () {
  'use strict';

  window.firebaseWriteServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    const TIMESTAMP_FIELDS = new Set([
      'start_date', 'end_date', 'scheduled_release_date', 'actual_release_date',
      'confirmed_at', 'setup_complete_date', 'created_at', 'updated_at', 'action_date'
    ]);

    function toFirestoreValue(field, value) {
      if (value === null || value === undefined) return value;
      if (TIMESTAMP_FIELDS.has(field) && typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      if (Array.isArray(value)) return value.map(v => toFirestoreValue(field, v));
      if (typeof value === 'object' && !(value instanceof Date)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = toFirestoreValue(k, v);
        return out;
      }
      return value;
    }

    function convertObject(input) {
      const out = {};
      for (const [k, v] of Object.entries(input || {})) {
        if (v !== undefined) out[k] = toFirestoreValue(k, v);
      }
      return out;
    }

    function makeLog(courseId, log, actor) {
      const now = new Date().toISOString();
      const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('log_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      return {
        id,
        course_id: courseId,
        course_name: log.course_name ?? null,
        action_type: log.action_type,
        action_date: log.action_date || now,
        user_name: actor?.name || log.user_name || '',
        user_role: actor?.role || log.user_role || '',
        quantity: log.quantity ?? null,
        previous_status: log.previous_status ?? null,
        new_status: log.new_status ?? null,
        notes: log.notes ?? '',
        created_at: now
      };
    }

    async function updateCourseWithLog({ courseId, updates, log, actor, expectedStatus }) {
      if (!courseId) throw new Error('courseId가 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const courseRef = fs.doc(db, 'courses', String(courseId));
      const logData = makeLog(String(courseId), log, actor);
      const logRef = fs.doc(db, 'work_logs', logData.id);

      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(courseRef);
        if (!snap.exists()) throw new Error('대상 과정이 존재하지 않습니다.');
        const current = snap.data();
        if (expectedStatus !== undefined && expectedStatus !== null && current.status !== expectedStatus) {
          const err = new Error(`상태가 변경되었습니다. 현재=${current.status}, 예상=${expectedStatus}`);
          err.code = 'mg/conflict-status';
          throw err;
        }
        tx.update(courseRef, convertObject(updates));
        tx.set(logRef, convertObject(logData));
      });
      return { logId: logData.id };
    }

    async function deleteCourseWithLog({ courseId, log, actor, expectedStatus }) {
      if (!courseId) throw new Error('courseId가 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const courseRef = fs.doc(db, 'courses', String(courseId));
      const logData = makeLog(String(courseId), log, actor);
      const logRef = fs.doc(db, 'work_logs', logData.id);
      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(courseRef);
        if (!snap.exists()) throw new Error('대상 과정이 존재하지 않습니다.');
        const current = snap.data();
        if (expectedStatus !== undefined && expectedStatus !== null && current.status !== expectedStatus) {
          const err = new Error(`상태가 변경되었습니다. 현재=${current.status}, 예상=${expectedStatus}`);
          err.code = 'mg/conflict-status';
          throw err;
        }
        tx.delete(courseRef);
        tx.set(logRef, convertObject(logData));
      });
      return { logId: logData.id };
    }

    async function insertCourseWithLog({ course, log, actor }) {
      if (!course?.id) throw new Error('신규 과정 id가 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const courseRef = fs.doc(db, 'courses', String(course.id));
      const logData = makeLog(String(course.id), log, actor);
      const logRef = fs.doc(db, 'work_logs', logData.id);
      const batch = fs.writeBatch(db);
      batch.set(courseRef, convertObject(course));
      batch.set(logRef, convertObject(logData));
      await batch.commit();
      return { logId: logData.id };
    }

    async function logOnly({ courseId, log, actor }) {
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      const logData = makeLog(String(courseId), log, actor);
      const logRef = fs.doc(db, 'work_logs', logData.id);
      await fs.setDoc(logRef, convertObject(logData));
      return { logId: logData.id };
    }

    const service = { updateCourseWithLog, deleteCourseWithLog, insertCourseWithLog, logOnly };
    window.firebaseWriteService = service;
    return service;
  })();
})();
