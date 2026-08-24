// Course / textbook workflow v2.
// Adds scheduled-course creation, parent-linked sub-books, weekly sub-book release,
// and guarded inventory-link diagnostics without changing legacy inventory totals.
(function () {
  'use strict';

  const V2 = { audit: { issues: [], repaired: [] }, installing: false, installed: false };
  window.inventoryWorkflowV2 = V2;

  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const norm = value => clean(value).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
  const n = value => {
    const x = Number(value || 0);
    return Number.isFinite(x) ? x : 0;
  };
  const makeId = prefix => globalThis.crypto?.randomUUID
    ? `${prefix}_${crypto.randomUUID()}`
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  function hash(value) {
    let h = 2166136261;
    const text = norm(value) || 'inventory';
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function existingGroupForName(name) {
    const wanted = norm(name);
    if (!wanted) return null;
    try { return state.groups.find(g => norm(g.name) === wanted) || null; } catch (_) { return null; }
  }

  function stableGroupKey(name) {
    const existing = existingGroupForName(name);
    return existing?.key || `book_${hash(name)}`;
  }

  function subBalance(book) {
    return n(book.stock_quantity) - n(book.released_quantity) + n(book.inventory_adjustment);
  }

  function linkedSubs(group) {
    if (!group) return [];
    const key = String(group.key || '');
    const groupName = norm(group.name);
    try {
      return state.subBooks.filter(book => {
        if (book.inventory_hidden === true) return false;
        const bookKey = String(book.course_group_key || '');
        const bookName = norm(book.course_group_name || book.course_group_key || '');
        return bookKey === key || (!!groupName && bookName === groupName);
      });
    } catch (_) { return []; }
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

  async function createScheduledCourse({ courseName, startDate, expectedQty, mainBookName, initialStock, actor, memo }) {
    if (!actor?.canManage) throw new Error('새 과정 등록은 주나연 담당자만 할 수 있습니다.');
    const course = clean(courseName);
    const book = clean(mainBookName) || course;
    const expected = Number(expectedQty || 0);
    const stock = Number(initialStock || 0);
    if (!course) throw new Error('과정명을 입력해주세요.');
    if (!startDate) throw new Error('시작일을 입력해주세요.');
    if (!Number.isInteger(expected) || expected < 0) throw new Error('예상 수량은 0권 이상 정수로 입력해주세요.');
    if (!Number.isInteger(stock) || stock < 0) throw new Error('첫 입고 수량은 0권 이상 정수로 입력해주세요.');

    const { fs, db } = await firestoreContext();
    const courseId = makeId('course');
    const groupKey = stableGroupKey(book);
    const now = fs.Timestamp.now();
    const start = timestampForLocalDate(fs, startDate);
    const status = stock > 0 ? '입고완료' : '입고대기';
    const batch = fs.writeBatch(db);
    const courseRef = fs.doc(db, 'courses', courseId);

    batch.set(courseRef, {
      id: courseId,
      course_name: course,
      inventory_display_name: book,
      inventory_group_key: groupKey,
      inventory_item_type: '주교재',
      inventory_only: false,
      inventory_ledger_only: false,
      inventory_hidden: false,
      status,
      stock_quantity: stock,
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

    const createLogId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', createLogId), {
      id: createLogId,
      course_id: courseId,
      course_name: course,
      action_type: '과정등록',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      previous_status: null,
      new_status: status,
      notes: `새 과정 · 시작 ${startDate} · 주교재 ${book}${memo ? ` · ${clean(memo)}` : ''}`
    });

    if (stock > 0) {
      const stockLogId = makeId('log');
      batch.set(fs.doc(db, 'work_logs', stockLogId), {
        id: stockLogId,
        course_id: courseId,
        course_name: course,
        action_type: '입고',
        action_date: now,
        created_at: now,
        user_name: actor.name,
        user_role: actor.role || '',
        quantity: stock,
        previous_status: '입고대기',
        new_status: '입고완료',
        notes: `신규 과정 등록과 함께 첫 입고 ${stock}권 · 주교재 ${book}`
      });
    }

    await batch.commit();
    return { courseId, groupKey, courseName: course, mainBookName: book, startDate };
  }

  async function createLinkedSubBook({ group, bookName, initialStock, actor, memo }) {
    if (!actor?.canManage) throw new Error('부교재 등록은 주나연 담당자만 할 수 있습니다.');
    if (!group?.key) throw new Error('연결할 과정을 찾을 수 없습니다.');
    const name = clean(bookName);
    const stock = Number(initialStock || 0);
    if (!name) throw new Error('부교재명을 입력해주세요.');
    if (!Number.isInteger(stock) || stock < 0) throw new Error('첫 입고 수량은 0권 이상 정수로 입력해주세요.');

    const { fs, db } = await firestoreContext();
    const id = makeId('subbook');
    const now = fs.Timestamp.now();
    const batch = fs.writeBatch(db);
    const ref = fs.doc(db, 'sub_books', id);
    batch.set(ref, {
      id,
      book_name: name,
      inventory_display_name: name,
      course_group_key: group.key,
      course_group_name: group.name,
      stock_quantity: stock,
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
      action_type: stock > 0 ? '등록+입고' : '등록',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user: actor.name,
      user_role: actor.role || '',
      quantity: stock > 0 ? stock : null,
      before_balance: 0,
      after_balance: stock,
      notes: `부교재 등록 · ${group.name}${stock > 0 ? ` · 첫 입고 ${stock}권` : ''}${memo ? ` · ${clean(memo)}` : ''}`
    });
    await batch.commit();
    return { id, name, balance: stock };
  }

  async function stockOutSubBook({ subBookId, course, quantity, actor, memo }) {
    if (!actor?.name) throw new Error('작업자가 선택되지 않았습니다.');
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('출고 수량은 1권 이상 정수로 입력해주세요.');
    const { fs, db } = await firestoreContext();
    const ref = fs.doc(db, 'sub_books', String(subBookId));
    return fs.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('부교재를 찾을 수 없습니다.');
      const book = { id: snap.id, ...snap.data() };
      const before = subBalance(book);
      if (before < 0) throw new Error('현재 부교재 잔고가 음수입니다. 실물 수량을 확인해주세요.');
      if (qty > before) throw new Error(`현재 부교재 잔고 ${before}권보다 많이 출고할 수 없습니다.`);
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
        course_id: course?.id ? String(course.id) : null,
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
      return { before, after, name: clean(book.inventory_display_name || book.book_name || '부교재'), logId };
    });
  }

  function findCourseById(id) {
    try { return state.courses.find(c => String(c.id) === String(id)); } catch (_) { return null; }
  }

  function findGroupForCourse(course) {
    if (!course) return null;
    try { return courseGroup(course); } catch (_) { return null; }
  }

  function stockClass(balance) {
    if (balance < 0) return 'error';
    if (balance < 50) return 'bad';
    if (balance < 100) return 'mid';
    return 'good';
  }

  function escSafe(value) {
    try { return esc(value); } catch (_) {
      return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }
  }

  function addStyles() {
    if (document.getElementById('course-workflow-v2-style')) return;
    const style = document.createElement('style');
    style.id = 'course-workflow-v2-style';
    style.textContent = `
      .v2-sub-wrap{margin-top:12px;padding-top:12px;border-top:1px dashed #cbd5e1}
      .v2-sub-title{font-size:12px;font-weight:950;color:#64748b;margin-bottom:7px}
      .v2-sub-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:13px;padding:10px 11px;margin-top:7px}
      .v2-sub-name{font-size:14px;font-weight:900;line-height:1.35}
      .v2-sub-meta{font-size:12px;color:#64748b;margin-top:3px}
      .v2-sub-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .v2-sub-actions .btn{min-height:40px;padding:0 11px}
      .v2-add-sub{border:1px dashed #93c5fd!important;background:#eff6ff!important;color:#1d4ed8!important}
      .v2-audit{background:#fff;border:1px solid #f59e0b;border-radius:15px;padding:12px 14px;margin-bottom:12px;color:#92400e;font-size:13px;line-height:1.55}
      .v2-course-date{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      @media(max-width:430px){.v2-course-date{grid-template-columns:1fr}.v2-sub-row{grid-template-columns:1fr}.v2-sub-actions{justify-content:stretch}.v2-sub-actions .btn{flex:1}}
    `;
    document.head.appendChild(style);
  }

  function overrideCreateCourseUi() {
    window.openCreateItem = function () {
      const actor = actorRequired();
      if (!actor?.canManage) { notice('새 과정 등록은 주나연 담당자만 가능합니다.'); return; }
      const today = new Date();
      const defaultDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      openSheet(`<div class="sheet-title">새 과정 등록</div>
        <div class="sheet-sub">시작일을 입력하면 해당 주차의 <b>출고</b> 화면에 자동으로 나타납니다.</div>
        <div class="field"><label>과정명</label><input id="v2CourseName" placeholder="예: 1Day클래스 PF 관련 실무"></div>
        <div class="v2-course-date">
          <div class="field"><label>과정 시작일</label><input id="v2StartDate" type="date" value="${defaultDate}"></div>
          <div class="field"><label>예상 교재 수량</label><input id="v2Expected" class="big-number" type="number" inputmode="numeric" min="0" value="0"></div>
        </div>
        <div class="field"><label>주교재명</label><input id="v2MainBook" placeholder="비워두면 과정명과 동일하게 사용"></div>
        <div class="field"><label>첫 입고 수량</label><input id="v2InitialStock" class="big-number" type="number" inputmode="numeric" min="0" value="0"></div>
        <div class="field"><label>메모 (선택)</label><textarea id="v2CourseMemo" placeholder="예: 신규 과정 / 초도 제작"></textarea></div>
        <div class="info-box" style="margin-top:14px"><b>등록 후 동작</b><br>입고 화면에 재고가 생성되고, 시작일이 속한 주차의 출고 화면에 과정이 자동 배치됩니다.</div>
        <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="v2CreateSubmit" class="btn blue">과정 등록</button></div>`);
      document.getElementById('v2CreateSubmit').onclick = async () => {
        const button = document.getElementById('v2CreateSubmit');
        button.disabled = true;
        try {
          const courseName = document.getElementById('v2CourseName').value.trim();
          const result = await createScheduledCourse({
            courseName,
            startDate: document.getElementById('v2StartDate').value,
            expectedQty: Number(document.getElementById('v2Expected').value || 0),
            mainBookName: document.getElementById('v2MainBook').value.trim() || courseName,
            initialStock: Number(document.getElementById('v2InitialStock').value || 0),
            actor,
            memo: document.getElementById('v2CourseMemo').value.trim()
          });
          closeSheet();
          notice(`${result.courseName} 등록 완료 · ${result.startDate} 출고 주차에 반영`);
          await loadAll();
        } catch (e) {
          console.error(e);
          notice('과정 등록 실패 · ' + (e.message || e));
          button.disabled = false;
        }
      };
    };
    const button = document.getElementById('createItemBtn');
    if (button) {
      button.textContent = '＋ 새 과정';
      button.onclick = window.openCreateItem;
    }
  }

  window.openLinkedSubCreate = function (groupKey) {
    const actor = actorRequired();
    const group = state.groups.find(g => g.key === groupKey);
    if (!actor?.canManage || !group) { notice('부교재 등록은 주나연 담당자만 가능합니다.'); return; }
    openSheet(`<div class="sheet-title">${escSafe(group.name)} · 부교재 등록</div>
      <div class="sheet-sub">이 부교재는 앞으로 이 과정의 <b>입고·출고 카드 아래에 항상 함께 표시</b>됩니다.</div>
      <div class="field"><label>부교재명</label><input id="v2SubName" placeholder="예: 실습교재 / 워크북"></div>
      <div class="field"><label>첫 입고 수량</label><input id="v2SubStock" class="big-number" type="number" inputmode="numeric" min="0" value="0"></div>
      <div class="field"><label>메모 (선택)</label><textarea id="v2SubMemo" placeholder="예: 주교재와 함께 사용"></textarea></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="v2SubCreateSubmit" class="btn blue">부교재 등록</button></div>`);
    document.getElementById('v2SubCreateSubmit').onclick = async () => {
      const button = document.getElementById('v2SubCreateSubmit');
      button.disabled = true;
      try {
        const result = await createLinkedSubBook({
          group,
          bookName: document.getElementById('v2SubName').value.trim(),
          initialStock: Number(document.getElementById('v2SubStock').value || 0),
          actor,
          memo: document.getElementById('v2SubMemo').value.trim()
        });
        closeSheet();
        notice(`${result.name} 부교재 등록 완료`);
        await loadAll();
      } catch (e) {
        console.error(e);
        notice('부교재 등록 실패 · ' + (e.message || e));
        button.disabled = false;
      }
    };
  };

  window.openLinkedSubOut = function (subBookId, courseId) {
    const actor = actorRequired();
    const book = state.subBooks.find(b => String(b.id) === String(subBookId));
    const course = findCourseById(courseId);
    if (!actor || !book || !course) return;
    const current = subBalance(book);
    if (current < 0) { notice('현재 부교재 잔고가 음수라 출고할 수 없습니다.'); return; }
    const name = clean(book.inventory_display_name || book.book_name || '부교재');
    openSheet(`<div class="sheet-title">${escSafe(name)} 출고</div>
      <div class="sheet-sub"><b>${escSafe(course.course_name)}</b> · 부교재</div>
      ${typeof balanceHero === 'function' ? balanceHero(current, '출고 후 잔고') : ''}
      <div class="field"><label>출고 수량</label><input id="v2SubOutQty" class="big-number" type="number" inputmode="numeric" min="1" max="${current}" placeholder="0"></div>
      <div class="chips"><button class="chip" onclick="setQty('v2SubOutQty',1)">1권</button><button class="chip" onclick="setQty('v2SubOutQty',5)">5권</button><button class="chip" onclick="setQty('v2SubOutQty',10)">10권</button></div>
      <div class="field"><label>메모 (선택)</label><textarea id="v2SubOutMemo" placeholder="예: 주교재와 함께 출고"></textarea></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="v2SubOutSubmit" class="btn orange">⇧ 출고 완료</button></div>`);
    if (typeof bindBalance === 'function') bindBalance('v2SubOutQty', current, 'out', 'v2SubOutSubmit');
    document.getElementById('v2SubOutSubmit').onclick = async () => {
      const button = document.getElementById('v2SubOutSubmit');
      button.disabled = true;
      try {
        const qty = Number(document.getElementById('v2SubOutQty').value);
        const result = await stockOutSubBook({
          subBookId,
          course,
          quantity: qty,
          actor,
          memo: document.getElementById('v2SubOutMemo').value.trim()
        });
        closeSheet();
        notice(`${result.name} -${qty}권 · 잔고 ${result.after}권`);
        await loadAll();
      } catch (e) {
        console.error(e);
        notice('부교재 출고 차단 · ' + (e.message || e));
        button.disabled = false;
      }
    };
  };

  function renderInV2() {
    const search = document.getElementById('inSearch');
    const q = clean(search?.value).toLowerCase();
    const groups = activeGroups().filter(g => !q || g.name.toLowerCase().includes(q) || linkedSubs(g).some(b => clean(b.inventory_display_name || b.book_name).toLowerCase().includes(q)));
    const html = groups.map(g => {
      const level = stockLevel(g);
      const manager = state.actor?.canManage;
      const subs = linkedSubs(g);
      const subHtml = subs.length ? `<div class="v2-sub-wrap"><div class="v2-sub-title">부교재 · 주교재와 함께 관리</div>${subs.map(b => {
        const bal = subBalance(b), name = clean(b.inventory_display_name || b.book_name || '부교재');
        return `<div class="v2-sub-row"><div><div class="v2-sub-name">${escSafe(name)}</div><div class="v2-sub-meta">현재 잔고 ${bal}권</div></div><div class="v2-sub-actions"><button class="btn green small" onclick="openSubIn('${escSafe(b.id)}')">⇩ 입고</button>${manager ? `<button class="btn small immediate-stock-btn" onclick="openImmediateOutSubBook('${escSafe(b.id)}')">⇧ 즉시출고</button>` : ''}</div></div>`;
      }).join('')}</div>` : '';
      return `<div class="inventory-card ${level.cls}"><div class="row"><div><div class="name">${escSafe(g.name)}</div><div class="meta">현재 잔고 ${g.balance}권 · 연결 과정 ${g.courses.filter(c => c.inventory_only !== true).length}개</div><div class="stock-status-row"><span class="badge ${level.cls}">${level.label}</span></div></div><button class="btn green small" onclick="openIn('${escSafe(g.key)}')">⇩ 입고</button></div>
        ${manager ? `<div class="action-row"><button class="btn small immediate-stock-btn" onclick="openImmediateOutGroup('${escSafe(g.key)}')">⇧ 즉시출고</button><button class="btn light small" onclick="openLinkedSubCreate('${escSafe(g.key)}')">＋ 부교재</button><button class="btn light small" onclick="openRename('${escSafe(g.key)}')">이름 변경</button><button class="btn light small" onclick="confirmHide('${escSafe(g.key)}')">운영 종료 · 숨기기</button></div>` : ''}${subHtml}</div>`;
    }).join('');
    const list = document.getElementById('inList');
    if (list) list.innerHTML = html || '<div class="empty">검색 결과가 없습니다.</div>';
  }

  function decorateWeekSubBooks() {
    document.querySelectorAll('#weekCourses .course-card').forEach(card => {
      if (card.querySelector('.v2-sub-wrap')) return;
      const outBtn = [...card.querySelectorAll('button')].find(b => /openOut\('/.test(b.getAttribute('onclick') || ''));
      if (!outBtn) return;
      const match = (outBtn.getAttribute('onclick') || '').match(/openOut\('([^']+)'\)/);
      if (!match) return;
      const course = findCourseById(match[1]);
      const group = findGroupForCourse(course);
      const subs = linkedSubs(group);
      if (!course || !subs.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'v2-sub-wrap';
      wrap.innerHTML = `<div class="v2-sub-title">부교재 · 이 과정과 함께 출고</div>${subs.map(book => {
        const bal = subBalance(book);
        const name = clean(book.inventory_display_name || book.book_name || '부교재');
        const disabled = bal <= 0 ? 'disabled' : '';
        return `<div class="v2-sub-row"><div><div class="v2-sub-name">${escSafe(name)}</div><div class="v2-sub-meta">현재 잔고 ${bal}권</div></div><div class="v2-sub-actions"><button class="btn orange small" ${disabled} onclick="openLinkedSubOut('${escSafe(book.id)}','${escSafe(course.id)}')">${bal <= 0 ? '출고 불가' : '출고'}</button></div></div>`;
      }).join('')}`;
      card.appendChild(wrap);
    });
  }

  function tokenSet(name) {
    return clean(name).toLowerCase().split(/[^0-9a-z가-힣]+/).filter(t => t.length >= 2 && !['과정','실무','클래스','교육','기본'].includes(t));
  }

  function similarity(a, b) {
    const A = new Set(tokenSet(a)), B = new Set(tokenSet(b));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const t of A) if (B.has(t)) hit++;
    return hit / Math.max(A.size, B.size);
  }

  function buildAudit() {
    const issues = [];
    try {
      const byName = new Map();
      for (const g of state.groups) {
        const k = norm(g.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(g);
      }
      for (const groups of byName.values()) {
        if (groups.length > 1) issues.push({ type: 'duplicate-group', text: `같은 교재명이 ${groups.length}개 재고그룹으로 분리됨: ${groups[0].name}` });
      }

      for (const c of state.courses.filter(x => x.inventory_only !== true)) {
        const current = findGroupForCourse(c);
        if (!current || current.balance !== 0) continue;
        const candidates = state.groups.filter(g => g.key !== current.key && g.balance > 0 && similarity(c.course_name, g.name) >= 0.5);
        if (candidates.length === 1) issues.push({ type: 'possible-link', text: `${c.course_name} · 출고 재고 0권 / 유사 재고 ${candidates[0].name} ${candidates[0].balance}권` });
      }

      for (const b of state.subBooks.filter(x => x.inventory_hidden !== true)) {
        const key = String(b.course_group_key || '');
        const name = norm(b.course_group_name || b.course_group_key || '');
        const linked = state.groups.some(g => (key && g.key === key) || (name && norm(g.name) === name));
        if (!linked) issues.push({ type: 'orphan-sub', text: `부교재 연결 과정 확인 필요: ${clean(b.inventory_display_name || b.book_name || '부교재')}` });
      }
    } catch (e) { console.warn('inventory audit failed', e); }
    V2.audit.issues = issues;
    window.inventoryLinkAudit = V2.audit;
    return issues;
  }

  async function repairKnownPfLink() {
    try {
      const pfCourses = state.courses.filter(c => c.inventory_only !== true && /pf\s*관련\s*실무/i.test(clean(c.course_name)));
      const targetGroups = state.groups.filter(g => /부동산\s*pf\s*대출\s*법률리스크와\s*대응전략/i.test(clean(g.name)));
      if (!pfCourses.length || targetGroups.length !== 1) return false;
      const target = targetGroups[0];
      const candidates = pfCourses.filter(c => {
        const current = findGroupForCourse(c);
        return current && current.key !== target.key && current.balance === 0 && target.balance > 0;
      });
      if (!candidates.length) return false;

      const { fs, db } = await firestoreContext();
      const batch = fs.writeBatch(db);
      const now = fs.Timestamp.now();
      for (const course of candidates) {
        batch.update(fs.doc(db, 'courses', String(course.id)), {
          inventory_group_key: target.key,
          inventory_display_name: target.name,
          inventory_link_repaired_at: now,
          inventory_link_repaired_reason: 'PF 관련 실무 ↔ 부동산 PF 대출 법률리스크와 대응전략 연결 복구',
          updated_at: now,
          updated_by: '시스템 연결점검'
        });
      }
      const logId = makeId('log');
      batch.set(fs.doc(db, 'work_logs', logId), {
        id: logId,
        course_id: candidates.map(c => c.id).join(','),
        course_name: candidates.map(c => c.course_name).join(' / '),
        action_type: '연결수정',
        action_date: now,
        created_at: now,
        user_name: '시스템 연결점검',
        user_role: '자동 데이터 정합성 점검',
        quantity: null,
        notes: `PF 과정 재고 연결 복구 · ${target.name} (${target.balance}권) 그룹으로 연결`
      });
      await batch.commit();
      V2.audit.repaired.push(`PF 과정 ${candidates.length}건 → ${target.name}`);
      return true;
    } catch (e) {
      console.warn('PF inventory link repair skipped', e);
      return false;
    }
  }

  function appendAuditUi() {
    const host = document.getElementById('integrityAlert');
    if (!host) return;
    host.querySelectorAll('.v2-audit').forEach(x => x.remove());
    const issues = V2.audit.issues;
    if (!issues.length && !V2.audit.repaired.length) return;
    const box = document.createElement('div');
    box.className = 'v2-audit';
    const repaired = V2.audit.repaired.length ? `<b>자동 복구</b> · ${V2.audit.repaired.map(escSafe).join(', ')}<br>` : '';
    const issueText = issues.length ? `<b>추가 연결 점검 ${issues.length}건</b><br>${issues.slice(0,3).map(i => `• ${escSafe(i.text)}`).join('<br>')}${issues.length > 3 ? `<br>외 ${issues.length-3}건` : ''}` : '<b>추가 연결 이상 없음</b>';
    box.innerHTML = repaired + issueText;
    host.appendChild(box);
  }

  function installOverrides() {
    if (V2.installed || V2.installing) return;
    if (typeof renderIn !== 'function' || typeof renderWeek !== 'function' || typeof loadAll !== 'function') {
      setTimeout(installOverrides, 50);
      return;
    }
    V2.installing = true;
    addStyles();
    overrideCreateCourseUi();

    const legacyRenderWeek = renderWeek;
    const legacyRenderHome = renderHome;
    const legacyLoadAll = loadAll;

    window.renderIn = renderInV2;
    window.renderWeek = function () { legacyRenderWeek(); decorateWeekSubBooks(); };
    window.renderHome = function () { legacyRenderHome(); buildAudit(); appendAuditUi(); };
    window.loadAll = async function () {
      await legacyLoadAll();
      const repaired = await repairKnownPfLink();
      if (repaired) await legacyLoadAll();
      buildAudit();
      renderInV2();
      decorateWeekSubBooks();
      appendAuditUi();
    };

    const search = document.getElementById('inSearch');
    if (search) {
      search.replaceWith(search.cloneNode(true));
      document.getElementById('inSearch').addEventListener('input', renderInV2);
    }

    V2.installed = true;
    V2.installing = false;
    try {
      buildAudit();
      renderInV2();
      decorateWeekSubBooks();
      appendAuditUi();
    } catch (e) { console.warn('workflow v2 initial render deferred', e); }
  }

  const start = () => setTimeout(installOverrides, 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
