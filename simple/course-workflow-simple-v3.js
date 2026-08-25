// Simple course <-> textbook workflow v3.
// Principle: one persisted inventory_group_key is the source of truth.
// No name-similarity inference, PF special cases, runtime aliases, or automatic link repair.
(function () {
  'use strict';

  const V3 = { installed: false, installing: false };
  window.courseWorkflowSimpleV3 = V3;

  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const n = value => {
    const x = Number(value || 0);
    return Number.isFinite(x) ? x : 0;
  };
  const makeId = prefix => globalThis.crypto?.randomUUID
    ? `${prefix}_${crypto.randomUUID()}`
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  function escSafe(value) {
    try { return esc(value); } catch (_) {
      return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
      }[c]));
    }
  }

  function hash(value) {
    let h = 2166136261;
    const text = clean(value).toLowerCase() || 'inventory';
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function subBalance(book) {
    return n(book.stock_quantity) - n(book.released_quantity) + n(book.inventory_adjustment);
  }

  function linkedSubs(group) {
    if (!group) return [];
    const key = String(group.key || '');
    return (state.subBooks || []).filter(book =>
      book.inventory_hidden !== true && String(book.course_group_key || '') === key
    );
  }

  function findCourse(id) {
    return (state.courses || []).find(c => String(c.id) === String(id)) || null;
  }

  function findGroup(key) {
    return (state.groups || []).find(g => String(g.key) === String(key)) || null;
  }

  async function firestoreContext() {
    const [fs, client] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js'),
      window.firebaseDbReady
    ]);
    return { fs, db: client.firebase.db };
  }

  function timestampForLocalDate(fs, ymd) {
    const d = new Date(`${ymd}T00:00:00+09:00`);
    if (Number.isNaN(d.getTime())) throw new Error('시작일을 확인해주세요.');
    return fs.Timestamp.fromDate(d);
  }

  async function createScheduledCourse({ courseName, startDate, expectedQty, groupKey, newBookName, actor, memo }) {
    if (!actor?.canManage) throw new Error('새 과정 등록은 주나연 담당자만 할 수 있습니다.');
    const course = clean(courseName);
    const expected = Number(expectedQty || 0);
    if (!course) throw new Error('과정명을 입력해주세요.');
    if (!startDate) throw new Error('시작일을 입력해주세요.');
    if (!Number.isInteger(expected) || expected < 0) throw new Error('예상 수량은 0권 이상 정수로 입력해주세요.');

    let selectedKey = clean(groupKey);
    let displayName = '';
    if (selectedKey) {
      const group = findGroup(selectedKey);
      if (!group) throw new Error('선택한 교재를 찾을 수 없습니다. 다시 선택해주세요.');
      displayName = clean(group.name);
    } else {
      displayName = clean(newBookName);
      if (!displayName) throw new Error('사용할 교재를 선택하거나 새 교재명을 입력해주세요.');
      selectedKey = `book_${hash(displayName)}_${Date.now().toString(36)}`;
    }

    const { fs, db } = await firestoreContext();
    const id = makeId('course');
    const now = fs.Timestamp.now();
    const start = timestampForLocalDate(fs, startDate);
    const batch = fs.writeBatch(db);

    batch.set(fs.doc(db, 'courses', id), {
      id,
      course_name: course,
      inventory_display_name: displayName,
      inventory_group_key: selectedKey,
      inventory_item_type: '주교재',
      inventory_only: false,
      inventory_ledger_only: false,
      inventory_hidden: false,
      status: '입고대기',
      stock_quantity: 0,
      released_quantity: 0,
      student_count: expected,
      start_date: start,
      end_date: null,
      scheduled_release_date: start,
      actual_release_date: null,
      notes: clean(memo),
      created_by: actor.name,
      updated_by: actor.name,
      created_at: now,
      updated_at: now
    });

    const logId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: id,
      course_name: course,
      action_type: '과정등록',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      previous_status: null,
      new_status: '입고대기',
      notes: `새 과정 · 시작 ${startDate} · 사용교재 ${displayName}${memo ? ` · ${clean(memo)}` : ''}`
    });

    await batch.commit();
    return { id, course, displayName };
  }

  async function changeCourseBook({ course, group, actor }) {
    if (!actor?.canManage) throw new Error('교재 연결 변경은 주나연 담당자만 할 수 있습니다.');
    if (!course || !group) throw new Error('과정 또는 교재를 찾을 수 없습니다.');
    if (n(course.stock_quantity) !== 0 || n(course.released_quantity) !== 0) {
      throw new Error('이미 입고/출고 이력이 있는 과정은 교재 연결을 바꿀 수 없습니다. 기존 기록을 보존하기 위한 제한입니다.');
    }
    if (String(course.inventory_group_key || '') === String(group.key)) return false;

    const { fs, db } = await firestoreContext();
    const now = fs.Timestamp.now();
    const batch = fs.writeBatch(db);
    batch.update(fs.doc(db, 'courses', String(course.id)), {
      inventory_group_key: group.key,
      inventory_display_name: group.name,
      updated_by: actor.name,
      updated_at: now
    });
    const logId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: String(course.id),
      course_name: course.course_name,
      action_type: '교재연결변경',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      notes: `사용교재 직접 변경 · ${clean(course.inventory_display_name || '')} → ${clean(group.name)}`
    });
    await batch.commit();
    return true;
  }

  async function createLinkedSubBook({ group, bookName, actor, memo }) {
    if (!actor?.canManage) throw new Error('부교재 등록은 주나연 담당자만 할 수 있습니다.');
    if (!group?.key) throw new Error('연결할 교재를 찾을 수 없습니다.');
    const name = clean(bookName);
    if (!name) throw new Error('부교재명을 입력해주세요.');

    const { fs, db } = await firestoreContext();
    const id = makeId('subbook');
    const now = fs.Timestamp.now();
    const batch = fs.writeBatch(db);
    batch.set(fs.doc(db, 'sub_books', id), {
      id,
      book_name: name,
      inventory_display_name: name,
      course_group_key: group.key,
      course_group_name: group.name,
      stock_quantity: 0,
      released_quantity: 0,
      inventory_adjustment: 0,
      inventory_hidden: false,
      notes: clean(memo),
      created_by: actor.name,
      updated_by: actor.name,
      created_at: now,
      updated_at: now
    });
    const logId = makeId('sublog');
    batch.set(fs.doc(db, 'sub_book_logs', logId), {
      id: logId,
      sub_book_id: id,
      book_id: id,
      book_name: name,
      course_name: name,
      course_group_key: group.key,
      course_group_name: group.name,
      action_type: '등록',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user: actor.name,
      user_role: actor.role || '',
      quantity: null,
      before_balance: 0,
      after_balance: 0,
      notes: `부교재 등록 · ${group.name}${memo ? ` · ${clean(memo)}` : ''}`
    });
    await batch.commit();
    return name;
  }

  async function stockOutSubBook({ subBookId, course, quantity, actor, memo }) {
    if (!actor?.name) throw new Error('작업자를 선택해주세요.');
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('출고 수량은 1권 이상 정수로 입력해주세요.');
    const { fs, db } = await firestoreContext();
    const ref = fs.doc(db, 'sub_books', String(subBookId));
    return fs.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('부교재를 찾을 수 없습니다.');
      const book = { id: snap.id, ...snap.data() };
      const before = subBalance(book);
      if (before < 0) throw new Error('현재 부교재 잔고가 음수입니다.');
      if (qty > before) throw new Error(`현재 잔고 ${before}권보다 많이 출고할 수 없습니다.`);
      const after = before - qty;
      const now = fs.Timestamp.now();
      tx.update(ref, {
        released_quantity: Math.max(0, n(book.released_quantity)) + qty,
        updated_at: now,
        updated_by: actor.name
      });
      const logId = makeId('sublog');
      tx.set(fs.doc(db, 'sub_book_logs', logId), {
        id: logId,
        sub_book_id: String(subBookId),
        book_id: String(subBookId),
        book_name: clean(book.inventory_display_name || book.book_name || '부교재'),
        course_id: String(course?.id || ''),
        course_name: course?.course_name || null,
        course_group_key: book.course_group_key || null,
        course_group_name: book.course_group_name || null,
        action_type: '출고',
        action_date: now,
        created_at: now,
        user_name: actor.name,
        user: actor.name,
        user_role: actor.role || '',
        quantity: qty,
        before_balance: before,
        after_balance: after,
        notes: `${course?.course_name ? `[${course.course_name}] ` : ''}부교재 출고 ${qty}권 · ${before}권 → ${after}권${memo ? ` · ${clean(memo)}` : ''}`
      });
      return { before, after, name: clean(book.inventory_display_name || book.book_name || '부교재') };
    });
  }

  function groupOptions(selectedKey = '') {
    return (activeGroups() || []).map(g =>
      `<option value="${escSafe(g.key)}" ${String(g.key) === String(selectedKey) ? 'selected' : ''}>${escSafe(g.name)} · ${g.balance}권</option>`
    ).join('');
  }

  function installCreateUi() {
    window.openCreateItem = function () {
      const actor = actorRequired();
      if (!actor?.canManage) return;
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      openSheet(`<div class="sheet-title">새 과정</div>
        <div class="sheet-sub">과정과 사용할 교재를 직접 연결합니다. 자동 추론은 하지 않습니다.</div>
        <div class="field"><label>과정명</label><input id="sv3CourseName" placeholder="과정명"></div>
        <div class="field"><label>시작일</label><input id="sv3StartDate" type="date" value="${ymd}"></div>
        <div class="field"><label>예상 수량</label><input id="sv3Expected" class="big-number" type="number" inputmode="numeric" min="0" value="0"></div>
        <div class="field"><label>사용 교재</label><select id="sv3Group"><option value="">＋ 새 교재 등록</option>${groupOptions()}</select></div>
        <div id="sv3NewBookWrap" class="field"><label>새 교재명</label><input id="sv3NewBook" placeholder="새 교재명을 입력"></div>
        <div class="field"><label>메모 (선택)</label><textarea id="sv3Memo"></textarea></div>
        <div class="info-box"><b>재고는 입고 메뉴에서 별도로 처리합니다.</b><br>과정 등록과 재고 입고를 분리해 구조를 단순하게 유지합니다.</div>
        <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="sv3Create" class="btn blue">등록</button></div>`);
      const select = document.getElementById('sv3Group');
      const sync = () => { document.getElementById('sv3NewBookWrap').style.display = select.value ? 'none' : 'block'; };
      select.addEventListener('change', sync); sync();
      document.getElementById('sv3Create').onclick = async () => {
        const btn = document.getElementById('sv3Create'); btn.disabled = true;
        try {
          const result = await createScheduledCourse({
            courseName: document.getElementById('sv3CourseName').value,
            startDate: document.getElementById('sv3StartDate').value,
            expectedQty: document.getElementById('sv3Expected').value,
            groupKey: select.value,
            newBookName: document.getElementById('sv3NewBook').value,
            actor,
            memo: document.getElementById('sv3Memo').value
          });
          closeSheet();
          notice(`${result.course} 등록 · 교재 ${result.displayName}`);
          await loadAll();
        } catch (e) {
          notice(e.message || String(e)); btn.disabled = false;
        }
      };
    };
    const button = document.getElementById('createItemBtn');
    if (button) { button.textContent = '＋ 새 과정'; button.onclick = window.openCreateItem; }
  }

  window.openCourseBookLink = function (courseId) {
    const actor = actorRequired();
    const course = findCourse(courseId);
    if (!actor?.canManage || !course) return;
    if (n(course.stock_quantity) !== 0 || n(course.released_quantity) !== 0) {
      notice('입고/출고 이력이 있는 과정은 교재 연결 변경이 잠겨 있습니다.');
      return;
    }
    openSheet(`<div class="sheet-title">사용 교재 변경</div>
      <div class="sheet-sub">${escSafe(course.course_name)}<br>자동 추천 없이 직접 선택합니다.</div>
      <div class="field"><label>교재</label><select id="sv3Relink">${groupOptions(course.inventory_group_key)}</select></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="sv3RelinkSave" class="btn blue">저장</button></div>`);
    document.getElementById('sv3RelinkSave').onclick = async () => {
      const group = findGroup(document.getElementById('sv3Relink').value);
      try {
        await changeCourseBook({ course, group, actor });
        closeSheet(); notice('사용 교재 연결을 변경했습니다.'); await loadAll();
      } catch (e) { notice(e.message || String(e)); }
    };
  };

  window.openLinkedSubCreate = function (groupKey) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    if (!actor?.canManage || !group) return;
    openSheet(`<div class="sheet-title">부교재 등록</div>
      <div class="sheet-sub">${escSafe(group.name)}에 직접 연결합니다.</div>
      <div class="field"><label>부교재명</label><input id="sv3SubName"></div>
      <div class="field"><label>메모 (선택)</label><textarea id="sv3SubMemo"></textarea></div>
      <div class="info-box">재고는 등록 후 입고 메뉴에서 처리합니다.</div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="sv3SubSave" class="btn blue">등록</button></div>`);
    document.getElementById('sv3SubSave').onclick = async () => {
      try {
        const name = await createLinkedSubBook({ group, bookName: document.getElementById('sv3SubName').value, actor, memo: document.getElementById('sv3SubMemo').value });
        closeSheet(); notice(`${name} 등록 완료`); await loadAll();
      } catch (e) { notice(e.message || String(e)); }
    };
  };

  window.openLinkedSubOut = function (subBookId, courseId) {
    const actor = actorRequired();
    const book = (state.subBooks || []).find(b => String(b.id) === String(subBookId));
    const course = findCourse(courseId);
    if (!actor || !book || !course) return;
    const current = subBalance(book);
    if (current <= 0) { notice('출고 가능한 부교재 재고가 없습니다.'); return; }
    const name = clean(book.inventory_display_name || book.book_name || '부교재');
    openSheet(`<div class="sheet-title">${escSafe(name)} 출고</div>
      <div class="sheet-sub">${escSafe(course.course_name)} · 부교재</div>
      ${typeof balanceHero === 'function' ? balanceHero(current, '출고 후 잔고') : ''}
      <div class="field"><label>수량</label><input id="sv3SubQty" class="big-number" type="number" inputmode="numeric" min="1" max="${current}"></div>
      <div class="field"><label>메모 (선택)</label><textarea id="sv3SubOutMemo"></textarea></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="sv3SubOut" class="btn orange">출고</button></div>`);
    if (typeof bindBalance === 'function') bindBalance('sv3SubQty', current, 'out', 'sv3SubOut');
    document.getElementById('sv3SubOut').onclick = async () => {
      try {
        const result = await stockOutSubBook({ subBookId, course, quantity: document.getElementById('sv3SubQty').value, actor, memo: document.getElementById('sv3SubOutMemo').value });
        closeSheet(); notice(`${result.name} · 잔고 ${result.after}권`); await loadAll();
      } catch (e) { notice(e.message || String(e)); }
    };
  };

  function renderInSimple() {
    const input = document.getElementById('inSearch');
    const q = clean(input?.value).toLowerCase();
    const groups = activeGroups().filter(g =>
      !q || clean(g.name).toLowerCase().includes(q) || linkedSubs(g).some(b => clean(b.inventory_display_name || b.book_name).toLowerCase().includes(q))
    );
    const manager = state.actor?.canManage;
    const html = groups.map(g => {
      const level = stockLevel(g);
      const subs = linkedSubs(g);
      const subHtml = subs.length ? `<div class="sv3-sub-wrap"><div class="sv3-sub-title">부교재</div>${subs.map(b => {
        const bal = subBalance(b);
        return `<div class="sv3-sub-row"><div><b>${escSafe(b.inventory_display_name || b.book_name)}</b><div class="meta">현재 ${bal}권</div></div><div><button class="btn green small" onclick="openSubIn('${escSafe(b.id)}')">입고</button>${manager ? ` <button class="btn light small" onclick="openImmediateOutSubBook('${escSafe(b.id)}')">즉시출고</button>` : ''}</div></div>`;
      }).join('')}</div>` : '';
      return `<div class="inventory-card ${level.cls}"><div class="row"><div><div class="name">${escSafe(g.name)}</div><div class="meta">현재 잔고 ${g.balance}권</div></div><button class="btn green small" onclick="openIn('${escSafe(g.key)}')">입고</button></div>${manager ? `<div class="action-row"><button class="btn small immediate-stock-btn" onclick="openImmediateOutGroup('${escSafe(g.key)}')">즉시출고</button><button class="btn light small" onclick="openLinkedSubCreate('${escSafe(g.key)}')">＋ 부교재</button><button class="btn light small" onclick="openRename('${escSafe(g.key)}')">이름 변경</button></div>` : ''}${subHtml}</div>`;
    }).join('');
    const list = document.getElementById('inList');
    if (list) list.innerHTML = html || '<div class="empty">검색 결과가 없습니다.</div>';
  }

  function decorateWeek() {
    document.querySelectorAll('#weekCourses .course-card').forEach(card => {
      if (card.querySelector('.sv3-actions')) return;
      const outBtn = [...card.querySelectorAll('button')].find(b => /openOut\('/.test(b.getAttribute('onclick') || ''));
      if (!outBtn) return;
      const match = (outBtn.getAttribute('onclick') || '').match(/openOut\('([^']+)'\)/);
      if (!match) return;
      const course = findCourse(match[1]);
      if (!course) return;
      const group = courseGroup(course);
      const subs = linkedSubs(group);
      const box = document.createElement('div');
      box.className = 'sv3-actions';
      const relink = state.actor?.canManage && n(course.stock_quantity) === 0 && n(course.released_quantity) === 0
        ? `<button class="btn light small" onclick="openCourseBookLink('${escSafe(course.id)}')">교재 변경</button>` : '';
      const subRows = subs.map(b => {
        const bal = subBalance(b);
        return `<div class="sv3-sub-row"><div><b>${escSafe(b.inventory_display_name || b.book_name)}</b><div class="meta">현재 ${bal}권</div></div><button class="btn orange small" ${bal <= 0 ? 'disabled' : ''} onclick="openLinkedSubOut('${escSafe(b.id)}','${escSafe(course.id)}')">${bal <= 0 ? '재고 없음' : '출고'}</button></div>`;
      }).join('');
      box.innerHTML = `${relink}${subRows ? `<div class="sv3-sub-wrap"><div class="sv3-sub-title">부교재</div>${subRows}</div>` : ''}`;
      card.appendChild(box);
    });
  }

  function addStyles() {
    if (document.getElementById('course-workflow-simple-v3-style')) return;
    const style = document.createElement('style');
    style.id = 'course-workflow-simple-v3-style';
    style.textContent = `
      .sv3-actions{margin-top:10px}.sv3-sub-wrap{margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1}
      .sv3-sub-title{font-size:12px;font-weight:900;color:#64748b;margin-bottom:6px}
      .sv3-sub-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:9px 10px;margin-top:6px}
      @media(max-width:430px){.sv3-sub-row{align-items:stretch;flex-direction:column}.sv3-sub-row .btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function install() {
    if (V3.installed || V3.installing) return;
    if (typeof renderWeek !== 'function' || typeof renderIn !== 'function' || typeof loadAll !== 'function') {
      setTimeout(install, 50); return;
    }
    V3.installing = true;
    addStyles();
    installCreateUi();

    const legacyRenderWeek = renderWeek;
    const legacyLoadAll = loadAll;
    window.renderIn = renderInSimple;
    window.renderWeek = function () { legacyRenderWeek(); decorateWeek(); };
    window.loadAll = async function () {
      await legacyLoadAll();
      renderInSimple();
      decorateWeek();
    };

    const search = document.getElementById('inSearch');
    if (search) {
      const clone = search.cloneNode(true);
      search.replaceWith(clone);
      clone.addEventListener('input', renderInSimple);
    }

    V3.installed = true;
    V3.installing = false;
    try { renderInSimple(); decorateWeek(); } catch (e) { console.warn('simple workflow v3 deferred', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(install, 0), { once:true });
  else setTimeout(install, 0);
})();
