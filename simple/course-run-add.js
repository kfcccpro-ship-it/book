// Add a new course run (차수) to an existing inventory group without editing prior runs.
// The new run shares the same inventory_group_key and starts with zero own stock/release,
// so the group's existing inventory balance remains unchanged until an actual outbound occurs.
(function () {
  'use strict';

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

  function findGroup(key) {
    return (state.groups || []).find(g => String(g.key) === String(key)) || null;
  }

  function runNo(name) {
    const matches = [...clean(name).matchAll(/(?:제\s*)?(\d+)\s*차/g)];
    if (!matches.length) return 0;
    return Math.max(...matches.map(m => Number(m[1]) || 0));
  }

  function baseCourseName(group) {
    const withRun = (group?.courses || []).find(c => runNo(c.course_name) > 0);
    if (!withRun) return clean(group?.name);
    const stripped = clean(withRun.course_name).replace(/\s*(?:제\s*)?\d+\s*차(?:\s*\([^)]*\))?\s*$/, '').trim();
    return stripped || clean(group?.name);
  }

  function nextRunNo(group) {
    const values = (group?.courses || []).map(c => runNo(c.course_name));
    return Math.max(0, ...values) + 1;
  }

  function asDate(value) {
    if (!value) return null;
    try {
      const d = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    } catch (_) { return null; }
  }

  function ymd(value) {
    const d = asDate(value);
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function existingRuns(group) {
    return (group?.courses || [])
      .map(c => ({ c, no: runNo(c.course_name), date: ymd(c.start_date || c.scheduled_release_date) }))
      .filter(x => x.no > 0)
      .sort((a, b) => a.no - b.no || String(a.date).localeCompare(String(b.date)));
  }

  async function firestoreContext() {
    const [fs, client] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js'),
      window.firebaseDbReady
    ]);
    return { fs, db: client.firebase.db };
  }

  function timestampForLocalDate(fs, value) {
    const d = new Date(`${value}T00:00:00+09:00`);
    if (Number.isNaN(d.getTime())) throw new Error('시작일을 확인해주세요.');
    return fs.Timestamp.fromDate(d);
  }

  async function addRun({ group, startDate, expectedQty, actor, memo }) {
    if (!actor?.canManage) throw new Error('차수 추가는 주나연 담당자만 할 수 있습니다.');
    if (!group?.key) throw new Error('기존 과정/교재를 찾을 수 없습니다.');
    if (!startDate) throw new Error('시작일을 입력해주세요.');

    const expected = Number(expectedQty);
    if (!Number.isInteger(expected) || expected < 0) throw new Error('예상 수량은 0권 이상 정수로 입력해주세요.');

    const no = nextRunNo(group);
    const base = baseCourseName(group);
    const courseName = `${base} ${no}차`;
    const { fs, db } = await firestoreContext();
    const id = makeId('course');
    const now = fs.Timestamp.now();
    const start = timestampForLocalDate(fs, startDate);
    const batch = fs.writeBatch(db);

    batch.set(fs.doc(db, 'courses', id), {
      id,
      course_name: courseName,
      inventory_display_name: group.name,
      inventory_group_key: group.key,
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
      course_name: courseName,
      action_type: '차수추가',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      previous_status: null,
      new_status: '입고대기',
      notes: `기존 과정에 ${no}차 추가 · 시작 ${startDate} · 예상 ${expected}권 · 기존 재고 ${group.balance}권 유지 · 동일 교재 재고 공유${memo ? ` · ${clean(memo)}` : ''}`
    });

    await batch.commit();
    return { no, courseName, startDate };
  }

  window.openAddCourseRun = function (groupKey) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    if (!actor?.canManage || !group) return;

    const no = nextRunNo(group);
    const runs = existingRuns(group);
    const runList = runs.length
      ? runs.map(x => `<div class="sv4-run-row"><b>${x.no}차</b><span>${x.date || '날짜 미설정'}</span></div>`).join('')
      : '<div class="meta">등록된 차수가 없습니다.</div>';

    openSheet(`<div class="sheet-title">${escSafe(group.name)} ${no}차 추가</div>
      <div class="sheet-sub">기존 차수는 그대로 두고 <b>${no}차를 새로 추가</b>합니다. 새 교재 재고는 만들지 않습니다.</div>
      <div class="sv4-run-list"><div class="sv4-run-title">현재 등록된 차수</div>${runList}</div>
      <div class="info-box"><b>새 차수: ${no}차</b><br>현재 교재 재고 ${group.balance}권을 기존 차수들과 함께 사용합니다.</div>
      <div class="field"><label>${no}차 시작일</label><input id="sv4RunDate" type="date"></div>
      <div class="field"><label>예상 수량</label><input id="sv4RunExpected" class="big-number" type="number" inputmode="numeric" min="0" value="30"></div>
      <div class="field"><label>메모 (선택)</label><textarea id="sv4RunMemo"></textarea></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="sv4RunSave" class="btn blue">${no}차 추가</button></div>`);

    document.getElementById('sv4RunSave').onclick = async () => {
      const btn = document.getElementById('sv4RunSave');
      btn.disabled = true;
      try {
        const result = await addRun({
          group,
          startDate: document.getElementById('sv4RunDate').value,
          expectedQty: document.getElementById('sv4RunExpected').value,
          actor,
          memo: document.getElementById('sv4RunMemo').value
        });
        closeSheet();
        notice(`${result.courseName} · ${result.startDate} 추가 완료`);
        await loadAll();
      } catch (e) {
        notice(e.message || String(e));
        btn.disabled = false;
      }
    };
  };

  // Keep the existing button hook for compatibility, but change its meaning from edit to add.
  window.openExistingCourseSchedule = window.openAddCourseRun;

  function patchUi() {
    document.querySelectorAll('button[onclick*="openExistingCourseSchedule"]').forEach(button => {
      button.textContent = '+ 차수 추가';
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.parentElement || /^(SCRIPT|STYLE|TEXTAREA|OPTION)$/i.test(node.parentElement.tagName)) continue;
      if ((node.nodeValue || '').includes('입고 화면의 ‘일정 설정’')) {
        node.nodeValue = node.nodeValue.replace('입고 화면의 ‘일정 설정’', '입고 화면의 ‘+ 차수 추가’');
      }
    }
  }

  function addStyles() {
    if (document.getElementById('course-run-add-style')) return;
    const style = document.createElement('style');
    style.id = 'course-run-add-style';
    style.textContent = `
      .sv4-run-list{margin:14px 0;padding:12px 14px;border:1px solid #dbe3ef;border-radius:14px;background:#f8fafc}
      .sv4-run-title{font-size:13px;font-weight:900;color:#475569;margin-bottom:6px}
      .sv4-run-row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid #e2e8f0;font-size:14px}
      .sv4-run-row:first-of-type{border-top:0}
    `;
    document.head.appendChild(style);
  }

  addStyles();
  patchUi();
  new MutationObserver(patchUi).observe(document.body, { childList: true, subtree: true });
  window.courseRunAddReady = true;
})();
