// Simple mobile inventory service.
// Core: safe stock-in/out, emergency issue, physical-stock reconciliation,
// reversible hiding, display-name management, and simple item creation.
(function () {
  'use strict';

  window.simpleInventoryServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    const timestampFields = new Set([
      'actual_release_date', 'updated_at', 'action_date', 'created_at', 'inventory_hidden_at'
    ]);

    function convertValue(field, value) {
      if (value === null || value === undefined) return value;
      if (timestampFields.has(field) && typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      return value;
    }

    function convertObject(input) {
      const out = {};
      for (const [key, value] of Object.entries(input || {})) {
        if (value !== undefined) out[key] = convertValue(key, value);
      }
      return out;
    }

    function makeId(prefix) {
      return (globalThis.crypto && crypto.randomUUID)
        ? `${prefix}_${crypto.randomUUID()}`
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function cleanName(value) {
      return String(value || '').trim().replace(/\s+/g, ' ');
    }

    function safeNonNegative(value) {
      const n = Number(value || 0);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    function hashKey(value) {
      let h = 2166136261;
      const s = String(value || 'inventory');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    function ledgerId(groupKey) {
      return `inventory_ledger_${hashKey(groupKey)}`;
    }

    function makeLog({ courseId, courseName, type, quantity, actor, notes, previousStatus, newStatus }) {
      const now = new Date().toISOString();
      return {
        id: makeId('log'),
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

    function ledgerBase({ id, groupKey, groupName, actor, now }) {
      return {
        id,
        course_name: `[재고원장] ${groupName}`,
        inventory_display_name: groupName,
        inventory_group_key: groupKey,
        inventory_item_type: '재고원장',
        inventory_only: true,
        inventory_ledger_only: true,
        inventory_hidden: false,
        status: '재고관리',
        stock_quantity: 0,
        released_quantity: 0,
        student_count: 0,
        start_date: null,
        end_date: null,
        scheduled_release_date: null,
        actual_release_date: null,
        notes: '비상출고 및 실물재고 조정용 내부 원장',
        created_by: actor.name,
        updated_by: actor.name,
        created_at: now,
        updated_at: now
      };
    }

    async function readGroupInTransaction(tx, groupCourseIds, groupKey) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (ids.length > 150) throw new Error('한 교재에 연결된 과정이 너무 많습니다. 관리자 점검이 필요합니다.');
      const lid = ledgerId(groupKey);
      const ledgerRef = fs.doc(db, 'courses', lid);
      const rows = [];
      for (const id of ids) {
        if (id === lid) continue;
        const snap = await tx.get(fs.doc(db, 'courses', id));
        if (snap.exists()) rows.push({ id: snap.id, ref: snap.ref, data: snap.data() });
      }
      const ledgerSnap = await tx.get(ledgerRef);
      if (ledgerSnap.exists()) rows.push({ id: ledgerSnap.id, ref: ledgerSnap.ref, data: ledgerSnap.data() });
      const totalStock = rows.reduce((sum, row) => sum + safeNonNegative(row.data.stock_quantity), 0);
      const totalReleased = rows.reduce((sum, row) => sum + safeNonNegative(row.data.released_quantity), 0);
      return { rows, totalStock, totalReleased, balance: totalStock - totalReleased, ledgerRef, ledgerSnap, ledgerId: lid };
    }

    async function createInventoryItem({ name, itemType, initialStock, actor, memo }) {
      const displayName = cleanName(name);
      const qty = Number(initialStock || 0);
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('새 교재/과정 등록은 주나연 담당자만 할 수 있습니다.');
      if (!displayName) throw new Error('교재명 또는 과정명을 입력해주세요.');
      if (!Number.isInteger(qty) || qty < 0) throw new Error('첫 입고 수량은 0권 이상 정수로 입력해주세요.');

      const courseId = makeId('inventory');
      const now = new Date().toISOString();
      const status = qty > 0 ? '입고완료' : '입고대기';
      const course = {
        id: courseId,
        course_name: displayName,
        inventory_display_name: displayName,
        inventory_group_key: courseId,
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
      batch.set(fs.doc(db, 'courses', courseId), convertObject(course));
      const createLog = makeLog({
        courseId,
        courseName: displayName,
        type: '신규등록',
        actor,
        previousStatus: null,
        newStatus: status,
        notes: `${course.inventory_item_type} 신규 등록${memo ? ` · ${cleanName(memo)}` : ''}`
      });
      batch.set(fs.doc(db, 'work_logs', createLog.id), convertObject(createLog));

      let stockLogId = null;
      if (qty > 0) {
        const stockLog = makeLog({
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
        batch.set(fs.doc(db, 'work_logs', stockLog.id), convertObject(stockLog));
      }
      await batch.commit();
      return { courseId, createLogId: createLog.id, stockLogId };
    }

    async function renameInventoryGroup({ groupCourseIds, oldName, newName, actor }) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      const before = cleanName(oldName);
      const after = cleanName(newName);
      if (!actor?.canManage) throw new Error('이름 변경은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('이름을 변경할 대상이 없습니다.');
      if (ids.length > 450) throw new Error('연결된 과정이 너무 많아 한 번에 변경할 수 없습니다.');
      if (!after) throw new Error('새 이름을 입력해주세요.');
      if (before === after) throw new Error('현재 이름과 같습니다.');

      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db, 'courses', id), convertObject({ inventory_display_name: after, updated_by: actor.name, updated_at: now }));
      }
      const log = makeLog({
        courseId: `group:${ids[0]}`,
        courseName: after,
        type: '이름변경',
        actor,
        notes: `교재/과정 표시명 변경: "${before}" → "${after}"`
      });
      batch.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      await batch.commit();
      return { newName: after, logId: log.id };
    }

    async function stockInGroup({ targetCourseId, quantity, actor, memo }) {
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
        committedStock = safeNonNegative(current.stock_quantity) + qty;
        committedStatus = current.status === '입고대기' ? '입고완료' : current.status;
        const now = new Date().toISOString();
        const displayName = cleanName(current.inventory_display_name) || cleanName(current.course_name);
        const log = makeLog({
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
        tx.update(ref, convertObject({ stock_quantity: committedStock, status: committedStatus, updated_by: actor.name, updated_at: now }));
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { stockQuantity: committedStock, status: committedStatus, logId };
    }

    async function stockOutGroup({ targetCourseId, groupCourseIds, quantity, actor, memo }) {
      const qty = Number(quantity);
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!targetCourseId || !ids.includes(String(targetCourseId))) throw new Error('출고 대상 과정 정보가 올바르지 않습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('출고 수량은 1권 이상 정수로 입력해주세요.');

      const refs = ids.map(id => fs.doc(db, 'courses', id));
      let availableBefore = 0;
      let availableAfter = 0;
      let releasedAfter = 0;
      let logId = null;
      await fs.runTransaction(db, async tx => {
        const rows = [];
        for (const ref of refs) {
          const snap = await tx.get(ref);
          if (snap.exists()) rows.push({ id: snap.id, ref: snap.ref, data: snap.data() });
        }
        const target = rows.find(row => row.id === String(targetCourseId));
        if (!target) throw new Error('출고 대상 과정이 존재하지 않습니다.');
        const totalStock = rows.reduce((sum, row) => sum + safeNonNegative(row.data.stock_quantity), 0);
        const totalReleased = rows.reduce((sum, row) => sum + safeNonNegative(row.data.released_quantity), 0);
        availableBefore = totalStock - totalReleased;
        if (availableBefore < 0) throw new Error(`기존 재고 기록이 맞지 않아 출고할 수 없습니다. 입고 ${totalStock}권 / 출고 ${totalReleased}권을 먼저 확인해주세요.`);
        if (qty > availableBefore) throw new Error(`현재 잔고 ${availableBefore}권보다 많이 출고할 수 없습니다.`);
        releasedAfter = safeNonNegative(target.data.released_quantity) + qty;
        availableAfter = availableBefore - qty;
        if (availableAfter < 0) throw new Error('출고 후 잔고가 음수가 되는 작업은 저장할 수 없습니다.');
        const now = new Date().toISOString();
        const displayName = cleanName(target.data.inventory_display_name) || cleanName(target.data.course_name);
        const log = makeLog({
          courseId: targetCourseId,
          courseName: displayName,
          type: '출고',
          quantity: qty,
          actor,
          previousStatus: target.data.status,
          newStatus: '출고완료',
          notes: memo || `출고 ${qty}권 · 출고 후 잔고 ${availableAfter}권`
        });
        logId = log.id;
        tx.update(target.ref, convertObject({ released_quantity: releasedAfter, status: '출고완료', actual_release_date: now, updated_by: actor.name, updated_at: now }));
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { availableBefore, availableAfter, releasedAfter, logId };
    }

    async function emergencyOutGroup({ groupCourseIds, groupKey, groupName, quantity, actor, memo }) {
      const qty = Number(quantity);
      if (!actor?.canManage) throw new Error('비상출고는 주나연 담당자만 할 수 있습니다.');
      if (!groupKey || !groupName) throw new Error('교재 정보를 찾을 수 없습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('비상출고 수량은 1권 이상 정수로 입력해주세요.');

      let before = 0;
      let after = 0;
      let logId = null;
      await fs.runTransaction(db, async tx => {
        const group = await readGroupInTransaction(tx, groupCourseIds, groupKey);
        before = group.balance;
        if (before < 0) throw new Error('기존 재고 기록이 맞지 않아 비상출고할 수 없습니다. 먼저 실물재고 맞춤을 해주세요.');
        if (qty > before) throw new Error(`현재 잔고 ${before}권보다 많이 비상출고할 수 없습니다.`);
        after = before - qty;
        const now = new Date().toISOString();
        const currentLedger = group.ledgerSnap.exists() ? group.ledgerSnap.data() : ledgerBase({ id: group.ledgerId, groupKey, groupName, actor, now });
        const newReleased = safeNonNegative(currentLedger.released_quantity) + qty;
        const ledgerData = { ...currentLedger, inventory_display_name: groupName, inventory_group_key: groupKey, released_quantity: newReleased, status: '재고관리', updated_by: actor.name, updated_at: now };
        if (group.ledgerSnap.exists()) tx.update(group.ledgerRef, convertObject(ledgerData));
        else tx.set(group.ledgerRef, convertObject(ledgerData));
        const userMemo = cleanName(memo);
        const log = makeLog({
          courseId: group.ledgerId,
          courseName: groupName,
          type: '비상출고',
          quantity: qty,
          actor,
          previousStatus: '재고관리',
          newStatus: '재고관리',
          notes: `[비상출고] ${userMemo || '입고담당자 재량 출고'} · ${before}권 → ${after}권`
        });
        logId = log.id;
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { availableBefore: before, availableAfter: after, logId };
    }

    async function reconcilePhysicalStock({ groupCourseIds, groupKey, groupName, actualStock, actor, memo }) {
      const actual = Number(actualStock);
      if (!actor?.canManage) throw new Error('실물재고 맞춤은 주나연 담당자만 할 수 있습니다.');
      if (!groupKey || !groupName) throw new Error('교재 정보를 찾을 수 없습니다.');
      if (!Number.isInteger(actual) || actual < 0) throw new Error('실제 보유 수량은 0권 이상 정수로 입력해주세요.');

      let before = 0;
      let adjustment = 0;
      let logId = null;
      await fs.runTransaction(db, async tx => {
        const group = await readGroupInTransaction(tx, groupCourseIds, groupKey);
        before = group.balance;
        adjustment = actual - before;
        if (adjustment === 0) throw new Error('앱 잔고와 실물 수량이 같습니다. 조정할 내용이 없습니다.');
        const now = new Date().toISOString();
        const currentLedger = group.ledgerSnap.exists() ? group.ledgerSnap.data() : ledgerBase({ id: group.ledgerId, groupKey, groupName, actor, now });
        const ledgerData = { ...currentLedger, inventory_display_name: groupName, inventory_group_key: groupKey, status: '재고관리', updated_by: actor.name, updated_at: now };
        if (adjustment > 0) ledgerData.stock_quantity = safeNonNegative(currentLedger.stock_quantity) + adjustment;
        else ledgerData.released_quantity = safeNonNegative(currentLedger.released_quantity) + Math.abs(adjustment);
        if (group.ledgerSnap.exists()) tx.update(group.ledgerRef, convertObject(ledgerData));
        else tx.set(group.ledgerRef, convertObject(ledgerData));
        const signed = adjustment > 0 ? `+${adjustment}` : String(adjustment);
        const userMemo = cleanName(memo);
        const log = makeLog({
          courseId: group.ledgerId,
          courseName: groupName,
          type: '재고조정',
          quantity: Math.abs(adjustment),
          actor,
          previousStatus: '재고관리',
          newStatus: '재고관리',
          notes: `실물재고 맞춤 ${before}권 → ${actual}권 · 조정 ${signed}권${userMemo ? ` · ${userMemo}` : ''}`
        });
        logId = log.id;
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { balanceBefore: before, balanceAfter: actual, adjustment, logId };
    }

    async function setGroupHidden({ groupCourseIds, groupName, hidden, actor }) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!actor?.canManage) throw new Error('과정 숨김/복원은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('숨김 처리할 과정이 없습니다.');
      if (ids.length > 450) throw new Error('숨김 처리 대상이 너무 많습니다.');
      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db, 'courses', id), convertObject({ inventory_hidden: !!hidden, inventory_hidden_at: hidden ? now : null, inventory_hidden_by: hidden ? actor.name : null, updated_by: actor.name, updated_at: now }));
      }
      const log = makeLog({
        courseId: `group:${ids[0]}`,
        courseName: groupName,
        type: hidden ? '숨김' : '복원',
        actor,
        notes: hidden ? '운영 종료 · 재고 화면에서 숨김' : '숨긴 항목 · 재고 화면에 다시 표시'
      });
      batch.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      await batch.commit();
      return { hidden: !!hidden, logId: log.id };
    }

    const service = {
      createInventoryItem,
      renameInventoryGroup,
      stockInGroup,
      stockOutGroup,
      emergencyOutGroup,
      reconcilePhysicalStock,
      setGroupHidden
    };
    window.simpleInventoryService = service;
    return service;
  })();

  // UI enhancements layered on the simple app without changing the core screen structure.
  (function installSimpleInventoryUI() {
    const style = document.createElement('style');
    style.textContent = `
      .balance-hero{display:grid;grid-template-columns:1fr 34px 1fr;align-items:stretch;gap:8px;margin:14px 0 6px}
      .balance-panel{border:2px solid #dbe3ef;border-radius:18px;padding:13px 9px;text-align:center;background:#fff}
      .balance-panel.current{border-color:#93c5fd;background:#eff6ff}.balance-panel.after{border-color:#bfdbfe;background:#f8fbff}
      .balance-kicker{font-size:12px;font-weight:900;color:#64748b;margin-bottom:4px}.balance-number{font-size:36px;font-weight:950;letter-spacing:-1.2px;line-height:1.05;color:#1d4ed8;white-space:nowrap}
      .balance-number.bad{color:#dc2626}.balance-number.mid{color:#7c3aed}.balance-number.good{color:#2563eb}.balance-number.error{color:#991b1b}
      .balance-arrow{display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:950;color:#64748b}.balance-helper{text-align:center;font-size:12px;font-weight:850;color:#64748b;min-height:18px;margin:5px 0 2px}.balance-helper.danger{color:#b91c1c}
      #inList .inventory-card .meta.current-stock-emphasis{font-size:18px;font-weight:950;color:#0f172a;margin-top:6px}.course-balance-emphasis{margin-top:9px;padding:9px 10px;border-radius:12px;background:#f8fafc;border:1px solid #dbe3ef;font-size:16px;font-weight:950;color:#0f172a}.course-balance-emphasis strong{font-size:22px;color:#2563eb;margin-left:5px}
      .emergency-stock-btn{flex:1 0 100%;min-height:48px!important;background:#fff7ed!important;color:#c2410c!important;border:2px solid #fdba74!important}.emergency-choice{width:100%;min-height:72px;border-radius:16px;border:0;text-align:left;padding:13px 15px;font-weight:900;margin-top:10px}.emergency-choice strong{display:block;font-size:17px;margin-bottom:4px}.emergency-choice span{font-size:12px;font-weight:750;opacity:.82}.emergency-choice.out{background:#fff7ed;color:#9a3412;border:2px solid #fdba74}.emergency-choice.adjust{background:#f5f3ff;color:#6d28d9;border:2px solid #c4b5fd}.btn.purple{background:#7c3aed;color:#fff}.log-type.emergency{color:#c2410c}.log-type.adjust{color:#7c3aed}
      @media(max-width:390px){.balance-number{font-size:31px}.balance-hero{grid-template-columns:1fr 28px 1fr;gap:5px}}
    `;
    document.head.appendChild(style);

    function balanceClass(value) {
      if (value < 0) return 'error';
      if (value < 50) return 'bad';
      if (value < 100) return 'mid';
      return 'good';
    }

    function parseCurrentBalance(text) {
      const match = String(text || '').match(/현재\s*(?:교재\s*)?잔고\s*(-?\d+)\s*권/);
      return match ? Number(match[1]) : null;
    }

    function currentGroup(key) {
      try { return state.groups.find(g => g.key === key); } catch (_) { return null; }
    }

    function currentActor() {
      try { return actorRequired(); } catch (_) { return null; }
    }

    function groupIds(g) {
      return (g?.courses || []).map(c => c.id);
    }

    function heroHTML(current, afterLabel, afterValue) {
      return `<div class="balance-hero"><div class="balance-panel current"><div class="balance-kicker">현재 잔고</div><div class="balance-number ${balanceClass(current)}">${current}권</div></div><div class="balance-arrow">→</div><div class="balance-panel after"><div class="balance-kicker">${afterLabel}</div><div id="specialAfter" class="balance-number ${balanceClass(afterValue)}">${afterValue}권</div></div></div><div id="specialHelper" class="balance-helper">수량을 입력하면 처리 후 잔고가 바로 표시됩니다.</div>`;
    }

    window.openEmergencyStock = function(key) {
      const actor = currentActor();
      const g = currentGroup(key);
      if (!actor?.canManage) { notice('비상출고/재고맞춤은 주나연 담당자만 사용할 수 있습니다.'); return; }
      if (!g) return;
      openSheet(`<div class="sheet-title">${esc(g.name)} 재고 바로잡기</div><div class="balance-panel current" style="margin-top:14px"><div class="balance-kicker">현재 잔고</div><div class="balance-number ${balanceClass(g.balance)}">${g.balance}권</div></div><div class="sheet-sub" style="margin-top:10px">정식 과정 출고가 아닌 긴급 불출이나, 앱 수량과 실물 수량이 다를 때 사용합니다. 두 작업은 로그에서 구분하여 남습니다.</div><button id="emergencyChoiceOut" class="emergency-choice out"><strong>⇧ 비상출고</strong><span>급하게 1~몇 권이 실제로 나갔을 때</span></button><button id="emergencyChoiceAdjust" class="emergency-choice adjust"><strong>◎ 실물재고 맞춤</strong><span>앱 57권 · 실제 54권처럼 수량 차이를 바로잡을 때</span></button><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">닫기</button></div>`);
      document.getElementById('emergencyChoiceOut').onclick = () => window.openEmergencyOut(key);
      document.getElementById('emergencyChoiceAdjust').onclick = () => window.openPhysicalAdjust(key);
    };

    window.openEmergencyOut = function(key) {
      const actor = currentActor();
      const g = currentGroup(key);
      if (!actor?.canManage || !g) return;
      if (g.balance < 0) { notice('현재 기록 오류가 있어 비상출고할 수 없습니다. 실물재고 맞춤을 먼저 해주세요.'); return; }
      openSheet(`<div class="sheet-title">${esc(g.name)} 비상출고</div>${heroHTML(g.balance, '출고 후 잔고', g.balance)}<div class="field"><label>비상출고 수량</label><input id="emergencyQty" class="big-number" type="number" inputmode="numeric" min="1" max="${g.balance}" placeholder="0"></div><div class="chips"><button class="chip" data-emergency-qty="1">1권</button><button class="chip" data-emergency-qty="2">2권</button><button class="chip" data-emergency-qty="5">5권</button></div><div class="field"><label>메모 (선택)</label><textarea id="emergencyMemo" placeholder="예: 강사 추가 요청 / 긴급 불출"></textarea></div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="emergencySubmit" class="btn orange">⇧ 비상출고</button></div>`);
      const input = document.getElementById('emergencyQty');
      const update = () => {
        const qty = Number(input.value || 0);
        const after = g.balance - (Number.isFinite(qty) && qty > 0 ? qty : 0);
        const out = document.getElementById('specialAfter');
        const help = document.getElementById('specialHelper');
        out.className = `balance-number ${balanceClass(after)}`;
        if (after < 0) { out.textContent = '출고 불가'; help.textContent = `현재 잔고 ${g.balance}권을 초과합니다.`; help.classList.add('danger'); }
        else { out.textContent = `${after}권`; help.textContent = qty > 0 ? `비상출고 ${qty}권 처리 시 남는 재고` : '수량을 입력하면 처리 후 잔고가 바로 표시됩니다.'; help.classList.remove('danger'); }
        document.getElementById('emergencySubmit').disabled = !(Number.isInteger(qty) && qty > 0 && qty <= g.balance);
      };
      input.addEventListener('input', update);
      document.querySelectorAll('[data-emergency-qty]').forEach(btn => btn.onclick = () => { input.value = btn.dataset.emergencyQty; update(); });
      document.getElementById('emergencySubmit').onclick = async () => {
        const qty = Number(input.value);
        const button = document.getElementById('emergencySubmit');
        button.disabled = true;
        try {
          const result = await state.inventory.emergencyOutGroup({ groupCourseIds: groupIds(g), groupKey: g.key, groupName: g.name, quantity: qty, actor, memo: document.getElementById('emergencyMemo').value.trim() });
          closeSheet(); notice(`${g.name} 비상출고 ${qty}권 · 잔고 ${result.availableAfter}권`); await loadAll();
        } catch (e) { console.error(e); notice('비상출고 차단 · ' + (e.message || e)); button.disabled = false; }
      };
      update();
    };

    window.openPhysicalAdjust = function(key) {
      const actor = currentActor();
      const g = currentGroup(key);
      if (!actor?.canManage || !g) return;
      openSheet(`<div class="sheet-title">${esc(g.name)} 실물재고 맞춤</div>${heroHTML(g.balance, '맞춤 후 잔고', g.balance)}<div class="field"><label>실제로 세어본 수량</label><input id="physicalQty" class="big-number" type="number" inputmode="numeric" min="0" placeholder="실제 보유 권수"></div><div id="physicalDiff" class="balance-helper"></div><div class="field"><label>메모 (선택)</label><textarea id="physicalMemo" placeholder="예: 창고 실사 / 분실·누락 확인"></textarea></div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="physicalSubmit" class="btn purple">◎ 재고 맞춤</button></div>`);
      const input = document.getElementById('physicalQty');
      const update = () => {
        const raw = input.value;
        const actual = raw === '' ? null : Number(raw);
        const out = document.getElementById('specialAfter');
        const helper = document.getElementById('specialHelper');
        const diff = document.getElementById('physicalDiff');
        const valid = actual !== null && Number.isInteger(actual) && actual >= 0;
        if (!valid) { out.textContent = `${g.balance}권`; out.className = `balance-number ${balanceClass(g.balance)}`; helper.textContent = '실제로 세어본 수량을 입력하세요.'; diff.textContent = ''; document.getElementById('physicalSubmit').disabled = true; return; }
        out.textContent = `${actual}권`; out.className = `balance-number ${balanceClass(actual)}`;
        const delta = actual - g.balance;
        helper.textContent = `앱 잔고 ${g.balance}권 → 실물 잔고 ${actual}권`;
        diff.textContent = delta === 0 ? '현재 앱 잔고와 같습니다.' : `자동 조정 ${delta > 0 ? '+' : ''}${delta}권`;
        diff.classList.toggle('danger', delta < 0);
        document.getElementById('physicalSubmit').disabled = delta === 0;
      };
      input.addEventListener('input', update);
      document.getElementById('physicalSubmit').onclick = async () => {
        const actual = Number(input.value);
        const button = document.getElementById('physicalSubmit');
        button.disabled = true;
        try {
          const result = await state.inventory.reconcilePhysicalStock({ groupCourseIds: groupIds(g), groupKey: g.key, groupName: g.name, actualStock: actual, actor, memo: document.getElementById('physicalMemo').value.trim() });
          closeSheet(); notice(`${g.name} 실물재고 ${actual}권으로 맞춤 · 조정 ${result.adjustment > 0 ? '+' : ''}${result.adjustment}권`); await loadAll();
        } catch (e) { console.error(e); notice('재고 맞춤 실패 · ' + (e.message || e)); button.disabled = false; }
      };
      update();
    };

    function enhanceEmergencyButtons() {
      let actor;
      try { actor = state.actor; } catch (_) { return; }
      if (!actor?.canManage) return;
      document.querySelectorAll('#inList .inventory-card').forEach(card => {
        if (card.querySelector('.emergency-stock-btn')) return;
        const inButton = [...card.querySelectorAll('button')].find(b => /openIn\('/.test(b.getAttribute('onclick') || ''));
        if (!inButton) return;
        const match = (inButton.getAttribute('onclick') || '').match(/openIn\('([^']+)'\)/);
        if (!match) return;
        const key = match[1];
        let row = card.querySelector('.action-row');
        if (!row) { row = document.createElement('div'); row.className = 'action-row'; card.appendChild(row); }
        const button = document.createElement('button');
        button.className = 'btn small emergency-stock-btn';
        button.textContent = '⚡ 비상출고 / 실물재고 맞춤';
        button.onclick = () => window.openEmergencyStock(key);
        row.prepend(button);
      });
    }

    function enhanceBalances() {
      document.querySelectorAll('#inList .inventory-card .meta').forEach(el => {
        if (/^현재\s*잔고\s*-?\d+\s*권/.test(el.textContent.trim())) el.classList.add('current-stock-emphasis');
      });
      document.querySelectorAll('#weekCourses .course-card').forEach(card => {
        if (card.querySelector('.course-balance-emphasis')) return;
        const meta = card.querySelector('.meta');
        const current = meta ? parseCurrentBalance(meta.textContent) : null;
        if (current === null) return;
        const line = document.createElement('div');
        line.className = 'course-balance-emphasis';
        line.innerHTML = `현재 잔고 <strong>${current}권</strong>`;
        const top = card.querySelector('.course-top > div');
        if (top) top.appendChild(line);
      });
    }

    function enhanceNormalSheet() {
      const body = document.getElementById('sheetBody');
      if (!body || body.querySelector('.balance-hero')) return;
      const title = body.querySelector('.sheet-title');
      const input = body.querySelector('#inQty, #outQty');
      if (!title || !input) return;
      const mode = input.id === 'inQty' ? 'in' : 'out';
      const subtitle = body.querySelector('.sheet-sub');
      const current = parseCurrentBalance(subtitle ? subtitle.textContent : body.textContent);
      if (current === null) return;
      title.insertAdjacentHTML('afterend', heroHTML(current, mode === 'in' ? '입고 후 잔고' : '출고 후 잔고', current));
      const after = document.getElementById('specialAfter');
      const helper = document.getElementById('specialHelper');
      const update = () => {
        const q = Number(input.value || 0); const qty = Number.isFinite(q) && q > 0 ? q : 0; const value = mode === 'in' ? current + qty : current - qty;
        after.className = `balance-number ${balanceClass(value)}`;
        if (mode === 'out' && value < 0) { after.textContent = '출고 불가'; helper.textContent = `현재 잔고 ${current}권을 초과합니다.`; helper.classList.add('danger'); }
        else { after.textContent = `${value}권`; helper.textContent = qty > 0 ? `${mode === 'in' ? '입고' : '출고'} ${qty}권 처리 시 예상 잔고` : '수량을 입력하면 처리 후 잔고가 바로 표시됩니다.'; helper.classList.remove('danger'); }
      };
      input.addEventListener('input', update); input.addEventListener('change', update); update();
    }

    function enhanceLogTypes() {
      document.querySelectorAll('#logList .log').forEach(card => {
        const type = card.querySelector('.log-type'); if (!type) return;
        if (card.textContent.includes('[비상출고]')) { type.textContent = type.textContent.replace(/^출고/, '비상출고'); type.classList.add('emergency'); }
        if (type.textContent.startsWith('재고조정')) type.classList.add('adjust');
      });
    }

    function refresh() {
      enhanceBalances();
      enhanceEmergencyButtons();
      enhanceNormalSheet();
      enhanceLogTypes();
    }

    const start = () => {
      refresh();
      const observer = new MutationObserver(refresh);
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('click', event => { if (event.target.closest('.chip')) setTimeout(refresh, 0); }, true);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  })();
})();
