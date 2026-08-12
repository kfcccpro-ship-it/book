// Simple mobile inventory service.
// Guarantees: block negative stock on new outbound transactions, atomic stock mutation + log,
// reversible inventory-list hiding, and safe inventory display-name management.
(function () {
  'use strict';

  window.simpleInventoryServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    const timestampFields = new Set([
      'actual_release_date','updated_at','action_date','created_at',
      'inventory_hidden_at'
    ]);

    function cv(field, value) {
      if (value === null || value === undefined) return value;
      if (timestampFields.has(field) && typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      return value;
    }

    function object(input) {
      const out = {};
      for (const [k,v] of Object.entries(input || {})) {
        if (v !== undefined) out[k] = cv(k,v);
      }
      return out;
    }

    function uid(prefix) {
      return (globalThis.crypto && crypto.randomUUID)
        ? `${prefix}_${crypto.randomUUID()}`
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function cleanName(value) {
      return String(value || '').trim().replace(/\s+/g, ' ');
    }

    function logData({courseId, courseName, type, quantity, actor, notes, previousStatus, newStatus}) {
      const now = new Date().toISOString();
      return {
        id: uid('log'),
        course_id: String(courseId),
        course_name: courseName || '',
        action_type: type,
        action_date: now,
        user_name: actor?.name || '',
        user_role: actor?.role || '',
        quantity: quantity ?? null,
        previous_status: previousStatus ?? null,
        new_status: newStatus ?? null,
        notes: notes || '',
        created_at: now
      };
    }

    function finiteNonNegative(value) {
      const n = Number(value || 0);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    async function createInventoryItem({name, itemType, initialStock, actor, memo}) {
      const displayName = cleanName(name);
      const qty = Number(initialStock || 0);
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('새 교재 등록은 주나연 담당자만 할 수 있습니다.');
      if (!displayName) throw new Error('교재명 또는 과정명을 입력해주세요.');
      if (!Number.isInteger(qty) || qty < 0) throw new Error('첫 입고 수량은 0권 이상 정수로 입력해주세요.');

      const courseId = uid('inventory');
      const now = new Date().toISOString();
      const status = qty > 0 ? '입고완료' : '입고대기';
      const course = {
        id: courseId,
        course_name: displayName,
        inventory_display_name: displayName,
        inventory_item_type: cleanName(itemType) || '교재',
        inventory_only: true,
        inventory_hidden: false,
        status,
        stock_quantity: qty,
        released_quantity: 0,
        student_count: 0,
        start_date: null,
        end_date: null,
        scheduled_release_date: null,
        actual_release_date: null,
        notes: cleanName(memo),
        created_by: actor.name,
        updated_by: actor.name,
        created_at: now,
        updated_at: now
      };

      const batch = fs.writeBatch(db);
      batch.set(fs.doc(db, 'courses', courseId), object(course));

      const createLog = logData({
        courseId,
        courseName: displayName,
        type: '신규등록',
        quantity: null,
        actor,
        previousStatus: null,
        newStatus: status,
        notes: `${course.inventory_item_type} 신규 등록${memo ? ` · ${cleanName(memo)}` : ''}`
      });
      batch.set(fs.doc(db, 'work_logs', createLog.id), object(createLog));

      let stockLogId = null;
      if (qty > 0) {
        const stockLog = logData({
          courseId,
          courseName: displayName,
          type: '입고',
          quantity: qty,
          actor,
          previousStatus: '입고대기',
          newStatus: '입고완료',
          notes: `신규 등록과 함께 첫 입고 ${qty}권${memo ? ` · ${cleanName(memo)}` : ''}`
        });
        stockLogId = stockLog.id;
        batch.set(fs.doc(db, 'work_logs', stockLog.id), object(stockLog));
      }

      await batch.commit();
      return {courseId, createLogId: createLog.id, stockLogId};
    }

    async function renameInventoryGroup({groupCourseIds, oldName, newName, actor}) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      const before = cleanName(oldName);
      const after = cleanName(newName);
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('이름 변경은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('이름을 변경할 대상이 없습니다.');
      if (ids.length > 450) throw new Error('연결된 과정이 너무 많아 한 번에 변경할 수 없습니다.');
      if (!after) throw new Error('새 이름을 입력해주세요.');
      if (before === after) throw new Error('현재 이름과 같습니다.');

      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db, 'courses', id), object({
          inventory_display_name: after,
          updated_by: actor.name,
          updated_at: now
        }));
      }

      const log = logData({
        courseId: `group:${ids[0]}`,
        courseName: after,
        type: '이름변경',
        quantity: null,
        actor,
        notes: `교재/과정 표시명 변경: "${before}" → "${after}"`
      });
      batch.set(fs.doc(db, 'work_logs', log.id), object(log));
      await batch.commit();
      return {newName: after, logId: log.id};
    }

    async function stockInGroup({targetCourseId, quantity, actor, memo}) {
      const qty = Number(quantity);
      if (!targetCourseId) throw new Error('입고 대상 과정이 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('입고 수량은 1권 이상 정수로 입력해주세요.');

      const ref = fs.doc(db, 'courses', String(targetCourseId));
      let committedStock = 0;
      let committedStatus = null;
      let logId = null;

      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('입고 대상 과정이 존재하지 않습니다.');
        const current = snap.data();
        const oldStock = finiteNonNegative(current.stock_quantity);
        committedStock = oldStock + qty;
        committedStatus = current.status === '입고대기' ? '입고완료' : current.status;
        const now = new Date().toISOString();
        const displayName = cleanName(current.inventory_display_name) || cleanName(current.course_name);
        const log = logData({
          courseId: targetCourseId,
          courseName: displayName,
          type: '입고',
          quantity: qty,
          actor,
          previousStatus: current.status,
          newStatus: committedStatus,
          notes: memo || `블록 입고 ${qty}권`
        });
        logId = log.id;
        tx.update(ref, object({
          stock_quantity: committedStock,
          status: committedStatus,
          updated_by: actor.name,
          updated_at: now
        }));
        tx.set(fs.doc(db,'work_logs',log.id), object(log));
      });
      return {stockQuantity: committedStock, status: committedStatus, logId};
    }

    async function stockOutGroup({targetCourseId, groupCourseIds, quantity, actor, memo}) {
      const qty = Number(quantity);
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!targetCourseId || !ids.includes(String(targetCourseId))) throw new Error('출고 대상 과정 정보가 올바르지 않습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('출고 수량은 1권 이상 정수로 입력해주세요.');
      if (ids.length > 100) throw new Error('한 교재에 연결된 과정이 너무 많습니다. 관리자 점검이 필요합니다.');

      const refs = ids.map(id => fs.doc(db,'courses',id));
      let availableBefore = 0;
      let availableAfter = 0;
      let releasedAfter = 0;
      let logId = null;

      await fs.runTransaction(db, async tx => {
        const snaps = [];
        for (const ref of refs) snaps.push(await tx.get(ref));
        const rows = snaps.filter(s => s.exists()).map(s => ({id:s.id, ref:s.ref, data:s.data()}));
        const target = rows.find(r => r.id === String(targetCourseId));
        if (!target) throw new Error('출고 대상 과정이 존재하지 않습니다.');

        const totalStock = rows.reduce((s,r) => s + finiteNonNegative(r.data.stock_quantity), 0);
        const totalReleased = rows.reduce((s,r) => s + finiteNonNegative(r.data.released_quantity), 0);
        availableBefore = totalStock - totalReleased;

        if (availableBefore < 0) {
          const err = new Error(`기존 재고 기록이 맞지 않아 출고할 수 없습니다. 입고 ${totalStock}권 / 출고 ${totalReleased}권을 먼저 확인해주세요.`);
          err.code = 'mg/stock-integrity-error';
          throw err;
        }
        if (qty > availableBefore) {
          const err = new Error(`현재 잔고 ${availableBefore}권보다 많이 출고할 수 없습니다.`);
          err.code = 'mg/insufficient-group-stock';
          throw err;
        }

        const oldReleased = finiteNonNegative(target.data.released_quantity);
        releasedAfter = oldReleased + qty;
        availableAfter = availableBefore - qty;
        if (availableAfter < 0) {
          const err = new Error('출고 후 잔고가 음수가 되는 작업은 저장할 수 없습니다.');
          err.code = 'mg/negative-stock-blocked';
          throw err;
        }

        const now = new Date().toISOString();
        const newStatus = '출고완료';
        const displayName = cleanName(target.data.inventory_display_name) || cleanName(target.data.course_name);
        const log = logData({
          courseId: targetCourseId,
          courseName: displayName,
          type: '출고',
          quantity: qty,
          actor,
          previousStatus: target.data.status,
          newStatus,
          notes: memo || `출고 ${qty}권 · 출고 후 잔고 ${availableAfter}권`
        });
        logId = log.id;
        tx.update(target.ref, object({
          released_quantity: releasedAfter,
          status: newStatus,
          actual_release_date: now,
          updated_by: actor.name,
          updated_at: now
        }));
        tx.set(fs.doc(db,'work_logs',log.id), object(log));
      });
      return {availableBefore, availableAfter, releasedAfter, logId};
    }

    async function setGroupHidden({groupCourseIds, groupName, hidden, actor}) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('과정 숨김/복원은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('숨김 처리할 과정이 없습니다.');
      if (ids.length > 450) throw new Error('숨김 처리 대상이 너무 많습니다.');

      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db,'courses',id), object({
          inventory_hidden: !!hidden,
          inventory_hidden_at: hidden ? now : null,
          inventory_hidden_by: hidden ? actor.name : null,
          updated_by: actor.name,
          updated_at: now
        }));
      }

      const log = logData({
        courseId: `group:${ids[0]}`,
        courseName: groupName,
        type: hidden ? '숨김' : '복원',
        quantity: null,
        actor,
        notes: hidden ? '운영 종료 · 재고 화면에서 숨김' : '숨긴 항목 · 재고 화면에 다시 표시'
      });
      batch.set(fs.doc(db,'work_logs',log.id), object(log));
      await batch.commit();
      return {hidden: !!hidden, logId: log.id};
    }

    return {
      createInventoryItem,
      renameInventoryGroup,
      stockInGroup,
      stockOutGroup,
      setGroupHidden
    };
  })();
})();
