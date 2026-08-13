// Simple mobile inventory service.
// Core: safe stock-in/out, 주나연 전용 즉시출고, reversible hiding,
// display-name management, and simple item creation.
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
        notes: '주나연 즉시출고 전용 내부 원장',
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
      if (!actor?.canManage) throw new Error('새 교재/과정 등록은 주나연 담당자만 할 수 있습니다.');
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
        batch.update(fs.doc(db, 'courses', id), convertObject({
          inventory_display_name: after,
          updated_by: actor.name,
          updated_at: now
        }));
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
        tx.update(ref, convertObject({
          stock_quantity: committedStock,
          status: committedStatus,
          updated_by: actor.name,
          updated_at: now
        }));
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
        tx.update(target.ref, convertObject({
          released_quantity: releasedAfter,
          status: '출고완료',
          actual_release_date: now,
          updated_by: actor.name,
          updated_at: now
        }));
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { availableBefore, availableAfter, releasedAfter, logId };
    }

    async function immediateOutGroup({ groupCourseIds, groupKey, groupName, quantity, actor, memo }) {
      const qty = Number(quantity);
      if (!actor?.canManage) throw new Error('즉시출고는 주나연 담당자만 사용할 수 있습니다.');
      if (!groupKey || !groupName) throw new Error('교재 정보를 찾을 수 없습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('즉시출고 수량은 1권 이상 정수로 입력해주세요.');

      let before = 0;
      let after = 0;
      let logId = null;
      await fs.runTransaction(db, async tx => {
        const group = await readGroupInTransaction(tx, groupCourseIds, groupKey);
        before = group.balance;
        if (before < 0) throw new Error('현재 잔고가 음수인 품목은 즉시출고할 수 없습니다. 실물 수량을 먼저 확인해주세요.');
        if (qty > before) throw new Error(`현재 잔고 ${before}권보다 많이 즉시출고할 수 없습니다.`);
        after = before - qty;

        const now = new Date().toISOString();
        const currentLedger = group.ledgerSnap.exists()
          ? group.ledgerSnap.data()
          : ledgerBase({ id: group.ledgerId, groupKey, groupName, actor, now });
        const ledgerData = {
          ...currentLedger,
          inventory_display_name: groupName,
          inventory_group_key: groupKey,
          released_quantity: safeNonNegative(currentLedger.released_quantity) + qty,
          status: '재고관리',
          updated_by: actor.name,
          updated_at: now
        };
        if (group.ledgerSnap.exists()) tx.update(group.ledgerRef, convertObject(ledgerData));
        else tx.set(group.ledgerRef, convertObject(ledgerData));

        const userMemo = cleanName(memo);
        const log = makeLog({
          courseId: group.ledgerId,
          courseName: groupName,
          type: '즉시출고',
          quantity: qty,
          actor,
          previousStatus: '재고관리',
          newStatus: '재고관리',
          notes: `[즉시출고] ${userMemo || '입고담당자 재량 출고'} · ${before}권 → ${after}권`
        });
        logId = log.id;
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });
      return { availableBefore: before, availableAfter: after, logId };
    }

    async function immediateOutSubBook({ subBookId, quantity, actor, memo }) {
      const qty = Number(quantity);
      if (!actor?.canManage) throw new Error('즉시출고는 주나연 담당자만 사용할 수 있습니다.');
      if (!subBookId) throw new Error('부교재 정보를 찾을 수 없습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('즉시출고 수량은 1권 이상 정수로 입력해주세요.');

      const ref = fs.doc(db, 'sub_books', String(subBookId));
      let before = 0;
      let after = 0;
      let name = '';
      let logId = null;
      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('부교재를 찾을 수 없습니다.');
        const book = snap.data();
        name = cleanName(book.inventory_display_name) || cleanName(book.book_name) || '부교재';
        before = safeNonNegative(book.stock_quantity) - safeNonNegative(book.released_quantity) + Number(book.inventory_adjustment || 0);
        if (before < 0) throw new Error('현재 잔고가 음수인 부교재는 즉시출고할 수 없습니다.');
        if (qty > before) throw new Error(`현재 잔고 ${before}권보다 많이 즉시출고할 수 없습니다.`);
        after = before - qty;

        const now = fs.Timestamp.now();
        tx.update(ref, {
          released_quantity: safeNonNegative(book.released_quantity) + qty,
          updated_at: now,
          updated_by: actor.name
        });

        logId = makeId('sublog');
        tx.set(fs.doc(db, 'sub_book_logs', logId), {
          id: logId,
          sub_book_id: String(subBookId),
          book_name: name,
          course_group_key: book.course_group_key || null,
          course_group_name: book.course_group_name || null,
          action_type: '즉시출고',
          quantity: qty,
          action_date: now,
          created_at: now,
          user_name: actor.name,
          user_role: actor.role || '',
          before_balance: before,
          after_balance: after,
          notes: `[즉시출고] ${cleanName(memo) || '입고담당자 재량 출고'} · ${before}권 → ${after}권`
        });
      });
      return { name, availableBefore: before, availableAfter: after, logId };
    }

    async function setGroupHidden({ groupCourseIds, groupName, hidden, actor }) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!actor?.canManage) throw new Error('과정 숨김/복원은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('숨김 처리할 과정이 없습니다.');
      if (ids.length > 450) throw new Error('숨김 처리 대상이 너무 많습니다.');

      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db, 'courses', id), convertObject({
          inventory_hidden: !!hidden,
          inventory_hidden_at: hidden ? now : null,
          inventory_hidden_by: hidden ? actor.name : null,
          updated_by: actor.name,
          updated_at: now
        }));
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
      immediateOutGroup,
      immediateOutSubBook,
      setGroupHidden
    };
    window.simpleInventoryService = service;
    return service;
  })();

  // 주나연 전용 즉시출고 UI. 기존 화면 구조를 건드리지 않고 입고 카드에 한 버튼만 추가한다.
  (function installImmediateOutUI() {
    const style = document.createElement('style');
    style.textContent = `
      .immediate-stock-btn{background:#fff7ed!important;color:#c2410c!important;border:2px solid #fdba74!important;min-height:46px!important}
      .immediate-note{font-size:12px;color:#64748b;line-height:1.5;margin-top:8px}
    `;
    document.head.appendChild(style);

    function actor() {
      try { return window.state?.actor || state?.actor || null; } catch (_) { return null; }
    }

    function group(key) {
      try { return state.groups.find(g => g.key === key); } catch (_) { return null; }
    }

    function subBook(id) {
      try { return state.subBooks.find(b => String(b.id) === String(id)); } catch (_) { return null; }
    }

    function balanceClass(v) {
      if (v < 0) return 'error';
      if (v < 50) return 'bad';
      if (v < 100) return 'mid';
      return 'good';
    }

    function balanceHero(current) {
      return `<div class="balance-hero"><div class="balance-panel current"><div class="balance-kicker">현재 잔고</div><div class="balance-number ${balanceClass(current)}">${current}권</div></div><div class="balance-arrow">→</div><div class="balance-panel after"><div class="balance-kicker">즉시출고 후</div><div id="immediateAfter" class="balance-number ${balanceClass(current)}">${current}권</div></div></div><div id="immediateHelper" class="balance-helper">수량을 입력하면 남는 재고가 바로 표시됩니다.</div>`;
    }

    function bindQty(inputId, current, submitId) {
      const input = document.getElementById(inputId);
      const after = document.getElementById('immediateAfter');
      const helper = document.getElementById('immediateHelper');
      const submit = document.getElementById(submitId);
      const update = () => {
        const qty = Number(input.value || 0);
        const valid = Number.isInteger(qty) && qty > 0;
        const remain = current - (valid ? qty : 0);
        if (valid && remain < 0) {
          after.textContent = '출고 불가';
          after.className = 'balance-number error';
          helper.textContent = `현재 잔고 ${current}권을 초과합니다.`;
          helper.classList.add('danger');
          submit.disabled = true;
        } else {
          after.textContent = `${remain}권`;
          after.className = `balance-number ${balanceClass(remain)}`;
          helper.textContent = valid ? `즉시출고 ${qty}권 처리 후 남는 재고` : '수량을 입력하면 남는 재고가 바로 표시됩니다.';
          helper.classList.remove('danger');
          submit.disabled = !valid;
        }
      };
      input.addEventListener('input', update);
      document.querySelectorAll('[data-immediate-qty]').forEach(btn => {
        btn.onclick = () => { input.value = btn.dataset.immediateQty; update(); };
      });
      update();
    }

    window.openImmediateOutGroup = function(key) {
      const a = actor();
      const g = group(key);
      if (!a?.canManage) { notice('즉시출고는 주나연 담당자만 사용할 수 있습니다.'); return; }
      if (!g) return;
      if (g.balance < 0) { notice('현재 잔고가 음수인 품목은 즉시출고할 수 없습니다.'); return; }
      openSheet(`<div class="sheet-title">${esc(g.name)} 즉시출고</div><div class="sheet-sub">과정·차수와 관계없이 입고 담당자가 바로 출고 처리합니다. 모든 작업은 기록됩니다.</div>${balanceHero(g.balance)}<div class="field"><label>즉시출고 수량</label><input id="immediateQty" class="big-number" type="number" inputmode="numeric" min="1" max="${g.balance}" placeholder="0"></div><div class="chips"><button class="chip" data-immediate-qty="1">1권</button><button class="chip" data-immediate-qty="2">2권</button><button class="chip" data-immediate-qty="5">5권</button></div><div class="field"><label>메모 (선택)</label><textarea id="immediateMemo" placeholder="예: 강사 추가 요청 / 현장 즉시 불출"></textarea></div><div class="immediate-note">정식 과정 출고와 별도로 ‘즉시출고’ 로그가 남습니다.</div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="immediateSubmit" class="btn orange">⇧ 즉시출고</button></div>`);
      bindQty('immediateQty', g.balance, 'immediateSubmit');
      document.getElementById('immediateSubmit').onclick = async () => {
        const qty = Number(document.getElementById('immediateQty').value);
        const button = document.getElementById('immediateSubmit');
        button.disabled = true;
        try {
          const result = await state.inventory.immediateOutGroup({
            groupCourseIds: g.courses.map(c => c.id),
            groupKey: g.key,
            groupName: g.name,
            quantity: qty,
            actor: a,
            memo: document.getElementById('immediateMemo').value.trim()
          });
          closeSheet();
          notice(`${g.name} 즉시출고 ${qty}권 · 잔고 ${result.availableAfter}권`);
          await loadAll();
        } catch (e) {
          console.error(e);
          notice('즉시출고 차단 · ' + (e.message || e));
          button.disabled = false;
        }
      };
    };

    window.openImmediateOutSubBook = function(id) {
      const a = actor();
      const b = subBook(id);
      if (!a?.canManage) { notice('즉시출고는 주나연 담당자만 사용할 수 있습니다.'); return; }
      if (!b) return;
      const current = Number(b.stock_quantity || 0) - Number(b.released_quantity || 0) + Number(b.inventory_adjustment || 0);
      if (current < 0) { notice('현재 잔고가 음수인 부교재는 즉시출고할 수 없습니다.'); return; }
      const name = String(b.inventory_display_name || b.book_name || '부교재');
      openSheet(`<div class="sheet-title">${esc(name)} 즉시출고</div><div class="sheet-sub"><span class="badge sub">부교재</span> · 입고 담당자 재량 출고</div>${balanceHero(current)}<div class="field"><label>즉시출고 수량</label><input id="immediateQty" class="big-number" type="number" inputmode="numeric" min="1" max="${current}" placeholder="0"></div><div class="chips"><button class="chip" data-immediate-qty="1">1권</button><button class="chip" data-immediate-qty="2">2권</button><button class="chip" data-immediate-qty="5">5권</button></div><div class="field"><label>메모 (선택)</label><textarea id="immediateMemo" placeholder="예: 현장 즉시 불출"></textarea></div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="immediateSubmit" class="btn orange">⇧ 즉시출고</button></div>`);
      bindQty('immediateQty', current, 'immediateSubmit');
      document.getElementById('immediateSubmit').onclick = async () => {
        const qty = Number(document.getElementById('immediateQty').value);
        const button = document.getElementById('immediateSubmit');
        button.disabled = true;
        try {
          const result = await state.inventory.immediateOutSubBook({
            subBookId: id,
            quantity: qty,
            actor: a,
            memo: document.getElementById('immediateMemo').value.trim()
          });
          closeSheet();
          notice(`${result.name} 즉시출고 ${qty}권 · 잔고 ${result.availableAfter}권`);
          await loadAll();
        } catch (e) {
          console.error(e);
          notice('즉시출고 차단 · ' + (e.message || e));
          button.disabled = false;
        }
      };
    };

    function enhanceButtons() {
      const a = actor();
      if (!a?.canManage) return;

      document.querySelectorAll('#inList .inventory-card').forEach(card => {
        // 주교재: 입고 버튼의 group key를 재사용한다.
        const inBtn = [...card.querySelectorAll('button')].find(b => /openIn\('/.test(b.getAttribute('onclick') || ''));
        if (inBtn && !card.querySelector('.immediate-stock-btn')) {
          const match = (inBtn.getAttribute('onclick') || '').match(/openIn\('([^']+)'\)/);
          if (match) {
            let row = card.querySelector('.action-row');
            if (!row) { row = document.createElement('div'); row.className = 'action-row'; card.appendChild(row); }
            const btn = document.createElement('button');
            btn.className = 'btn small immediate-stock-btn';
            btn.textContent = '⇧ 즉시출고';
            btn.onclick = () => window.openImmediateOutGroup(match[1]);
            row.prepend(btn);
          }
        }

        // 부교재: 기존 복합 버튼을 단일 즉시출고 버튼으로 교체한다.
        const oldSubBtn = [...card.querySelectorAll('button')].find(b => /openSubEmergency\('/.test(b.getAttribute('onclick') || ''));
        if (oldSubBtn) {
          const match = (oldSubBtn.getAttribute('onclick') || '').match(/openSubEmergency\('([^']+)'\)/);
          if (match) {
            oldSubBtn.removeAttribute('onclick');
            oldSubBtn.className = 'btn small immediate-stock-btn';
            oldSubBtn.textContent = '⇧ 즉시출고';
            oldSubBtn.onclick = () => window.openImmediateOutSubBook(match[1]);
          }
        }
      });
    }

    function enhanceLogs() {
      document.querySelectorAll('#logList .log').forEach(card => {
        if (!card.textContent.includes('[즉시출고]')) return;
        const type = card.querySelector('.log-type');
        if (type && !type.textContent.startsWith('즉시출고')) {
          type.textContent = type.textContent.replace(/^출고/, '즉시출고');
        }
      });
    }

    function refresh() {
      enhanceButtons();
      enhanceLogs();
    }

    const start = () => {
      refresh();
      new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  })();
})();
