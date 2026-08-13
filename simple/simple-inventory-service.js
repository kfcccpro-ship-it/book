// Simple mobile inventory service.
// Core: safe stock-in/out, reversible hiding, display-name management, simple item creation.
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
        quantity: null,
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
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('이름 변경은 주나연 담당자만 할 수 있습니다.');
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
        quantity: null,
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
        const oldStock = safeNonNegative(current.stock_quantity);
        committedStock = oldStock + qty;
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
      if (ids.length > 100) throw new Error('한 교재에 연결된 과정이 너무 많습니다. 관리자 점검이 필요합니다.');

      const refs = ids.map(id => fs.doc(db, 'courses', id));
      let availableBefore = 0;
      let availableAfter = 0;
      let releasedAfter = 0;
      let logId = null;

      await fs.runTransaction(db, async tx => {
        const snaps = [];
        for (const ref of refs) snaps.push(await tx.get(ref));
        const rows = snaps.filter(s => s.exists()).map(s => ({ id: s.id, ref: s.ref, data: s.data() }));
        const target = rows.find(r => r.id === String(targetCourseId));
        if (!target) throw new Error('출고 대상 과정이 존재하지 않습니다.');

        const totalStock = rows.reduce((sum, row) => sum + safeNonNegative(row.data.stock_quantity), 0);
        const totalReleased = rows.reduce((sum, row) => sum + safeNonNegative(row.data.released_quantity), 0);
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

        const oldReleased = safeNonNegative(target.data.released_quantity);
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
        const log = makeLog({
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
        tx.update(target.ref, convertObject({
          released_quantity: releasedAfter,
          status: newStatus,
          actual_release_date: now,
          updated_by: actor.name,
          updated_at: now
        }));
        tx.set(fs.doc(db, 'work_logs', log.id), convertObject(log));
      });

      return { availableBefore, availableAfter, releasedAfter, logId };
    }

    async function setGroupHidden({ groupCourseIds, groupName, hidden, actor }) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!actor.canManage) throw new Error('과정 숨김/복원은 주나연 담당자만 할 수 있습니다.');
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
        quantity: null,
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
      setGroupHidden
    };
    window.simpleInventoryService = service;
    return service;
  })();

  // UI-only enhancement: make current stock the most visible information in stock-in/out flows.
  (function installBalanceUI() {
    const styleId = 'simple-balance-ui-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .balance-hero{display:grid;grid-template-columns:1fr 34px 1fr;align-items:stretch;gap:8px;margin:14px 0 6px}
        .balance-panel{border:2px solid #dbe3ef;border-radius:18px;padding:13px 9px;text-align:center;background:#fff}
        .balance-panel.current{border-color:#93c5fd;background:#eff6ff}
        .balance-panel.after{border-color:#bfdbfe;background:#f8fbff}
        .balance-kicker{font-size:12px;font-weight:900;color:#64748b;margin-bottom:4px}
        .balance-number{font-size:36px;font-weight:950;letter-spacing:-1.2px;line-height:1.05;color:#1d4ed8;white-space:nowrap}
        .balance-number.bad{color:#dc2626}.balance-number.mid{color:#7c3aed}.balance-number.good{color:#2563eb}.balance-number.error{color:#991b1b}
        .balance-arrow{display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:950;color:#64748b}
        .balance-helper{text-align:center;font-size:12px;font-weight:850;color:#64748b;min-height:18px;margin:5px 0 2px}
        .balance-helper.danger{color:#b91c1c}
        #inList .inventory-card .meta.current-stock-emphasis{font-size:18px;font-weight:950;color:#0f172a;margin-top:6px}
        .course-balance-emphasis{margin-top:9px;padding:9px 10px;border-radius:12px;background:#f8fafc;border:1px solid #dbe3ef;font-size:16px;font-weight:950;color:#0f172a}
        .course-balance-emphasis strong{font-size:22px;color:#2563eb;margin-left:5px}
        @media(max-width:390px){.balance-number{font-size:31px}.balance-hero{grid-template-columns:1fr 28px 1fr;gap:5px}}
      `;
      document.head.appendChild(style);
    }

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

    function enhanceListBalances(root) {
      const scope = root || document;
      scope.querySelectorAll('#inList .inventory-card .meta').forEach(el => {
        if (/^현재\s*잔고\s*-?\d+\s*권/.test(el.textContent.trim())) {
          el.classList.add('current-stock-emphasis');
        }
      });

      scope.querySelectorAll('#weekCourses .course-card').forEach(card => {
        if (card.querySelector('.course-balance-emphasis')) return;
        const meta = card.querySelector('.meta');
        if (!meta) return;
        const current = parseCurrentBalance(meta.textContent);
        if (current === null) return;
        const line = document.createElement('div');
        line.className = 'course-balance-emphasis';
        line.innerHTML = `현재 잔고 <strong class="${balanceClass(current)}">${current}권</strong>`;
        const top = card.querySelector('.course-top > div');
        if (top) top.appendChild(line);
      });
    }

    function removeBalanceFromSubtitle(subtitle) {
      if (!subtitle || subtitle.dataset.balanceCleaned === '1') return;
      subtitle.innerHTML = subtitle.innerHTML
        .replace(/현재\s*(?:교재\s*)?잔고\s*<b>-?\d+권<\/b>\s*·\s*/i, '')
        .replace(/현재\s*(?:교재\s*)?잔고\s*-?\d+권\s*·\s*/i, '');
      subtitle.dataset.balanceCleaned = '1';
    }

    function updatePreview() {
      const hero = document.querySelector('#sheetBody .balance-hero');
      if (!hero) return;
      const mode = hero.dataset.mode;
      const current = Number(hero.dataset.current || 0);
      const input = document.getElementById(mode === 'in' ? 'inQty' : 'outQty');
      const afterEl = hero.querySelector('[data-after]');
      const helper = hero.nextElementSibling && hero.nextElementSibling.classList.contains('balance-helper')
        ? hero.nextElementSibling
        : null;
      const raw = input ? Number(input.value || 0) : 0;
      const qty = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const after = mode === 'in' ? current + qty : current - qty;

      afterEl.className = `balance-number ${balanceClass(after)}`;
      if (mode === 'out' && after < 0) {
        afterEl.textContent = '출고 불가';
        if (helper) {
          helper.textContent = `현재 잔고 ${current}권을 초과합니다.`;
          helper.classList.add('danger');
        }
      } else {
        afterEl.textContent = `${after}권`;
        if (helper) {
          helper.textContent = qty > 0
            ? `${mode === 'in' ? '입고' : '출고'} ${qty}권 처리 시 예상 잔고`
            : '수량을 입력하면 처리 후 잔고가 바로 표시됩니다.';
          helper.classList.remove('danger');
        }
      }
    }

    function enhanceSheet() {
      const body = document.getElementById('sheetBody');
      if (!body || body.querySelector('.balance-hero')) return;
      const title = body.querySelector('.sheet-title');
      const input = body.querySelector('#inQty, #outQty');
      if (!title || !input) return;
      const mode = input.id === 'inQty' ? 'in' : 'out';
      if (!title.textContent.trim().endsWith(mode === 'in' ? '입고' : '출고')) return;

      const subtitle = body.querySelector('.sheet-sub');
      const current = parseCurrentBalance(subtitle ? subtitle.textContent : body.textContent);
      if (current === null) return;

      const hero = document.createElement('div');
      hero.className = 'balance-hero';
      hero.dataset.mode = mode;
      hero.dataset.current = String(current);
      hero.innerHTML = `
        <div class="balance-panel current">
          <div class="balance-kicker">현재 잔고</div>
          <div class="balance-number ${balanceClass(current)}">${current}권</div>
        </div>
        <div class="balance-arrow">→</div>
        <div class="balance-panel after">
          <div class="balance-kicker">${mode === 'in' ? '입고 후 잔고' : '출고 후 잔고'}</div>
          <div class="balance-number ${balanceClass(current)}" data-after>${current}권</div>
        </div>`;

      const helper = document.createElement('div');
      helper.className = 'balance-helper';
      helper.textContent = '수량을 입력하면 처리 후 잔고가 바로 표시됩니다.';

      if (subtitle) {
        title.insertAdjacentElement('afterend', hero);
        hero.insertAdjacentElement('afterend', helper);
        removeBalanceFromSubtitle(subtitle);
      } else {
        title.insertAdjacentElement('afterend', hero);
        hero.insertAdjacentElement('afterend', helper);
      }

      input.addEventListener('input', updatePreview);
      input.addEventListener('change', updatePreview);
      updatePreview();
    }

    function refreshEnhancements() {
      enhanceListBalances(document);
      enhanceSheet();
    }

    const start = () => {
      refreshEnhancements();
      const body = document.body;
      if (!body) return;
      const observer = new MutationObserver(() => refreshEnhancements());
      observer.observe(body, { childList: true, subtree: true });
      document.addEventListener('click', event => {
        if (event.target.closest('.chip')) setTimeout(updatePreview, 0);
      }, true);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();
})();
