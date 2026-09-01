// Unified course management from the inbound screen.
// Inbound is the control center for representative course name, run metadata, and soft deletion.
(function () {
  'use strict';

  const clean = v => String(v || '').trim().replace(/\s+/g, ' ');
  const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
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

  function findCourse(id) {
    return (state.courses || []).find(c => String(c.id) === String(id)) || null;
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
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function inferRunLabel(course, groupName) {
    const stored = clean(course?.course_run_label);
    if (stored) return stored;
    const name = clean(course?.course_name);
    const base = clean(groupName);
    if (base && name.startsWith(base) && name.length > base.length) return clean(name.slice(base.length));
    const match = name.match(/((?:제\s*)?\d+\s*차(?:\s*\([^)]*\))?.*)$/);
    return match ? clean(match[1]) : '';
  }

  function managedRuns(group) {
    return (group?.courses || [])
      .filter(c => c.inventory_ledger_only !== true && (c.inventory_only !== true || c.start_date || c.scheduled_release_date || c.course_run_label))
      .sort((a,b) => (asDate(a.start_date)||new Date(8640000000000000)) - (asDate(b.start_date)||new Date(8640000000000000)));
  }

  async function firestoreContext() {
    const [fs, client] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js'),
      window.firebaseDbReady
    ]);
    return { fs, db: client.firebase.db };
  }

  function localTimestamp(fs, value) {
    if (!value) return null;
    const d = new Date(`${value}T00:00:00+09:00`);
    if (Number.isNaN(d.getTime())) throw new Error('시작일을 확인해주세요.');
    return fs.Timestamp.fromDate(d);
  }

  async function renameRepresentative(group, newName, actor) {
    const before = clean(group.name);
    const after = clean(newName);
    if (!actor?.canManage) throw new Error('과정 정보 변경은 주나연 담당자만 가능합니다.');
    if (!after) throw new Error('대표과정명을 입력해주세요.');
    if (before === after) return false;

    const { fs, db } = await firestoreContext();
    const batch = fs.writeBatch(db);
    const now = fs.Timestamp.now();

    for (const course of group.courses) {
      const patch = {
        inventory_display_name: after,
        updated_by: actor.name,
        updated_at: now
      };
      if (course.inventory_ledger_only === true) {
        patch.course_name = `[재고원장] ${after}`;
      } else if (course.inventory_only === true && !course.start_date && !course.course_run_label) {
        patch.course_name = after;
      } else {
        const label = inferRunLabel(course, before);
        patch.course_run_label = label || null;
        patch.course_name = label ? `${after} ${label}` : after;
      }
      batch.update(fs.doc(db, 'courses', String(course.id)), patch);
    }

    for (const book of (state.subBooks || []).filter(b => String(b.course_group_key || '') === String(group.key))) {
      batch.update(fs.doc(db, 'sub_books', String(book.id)), {
        course_group_name: after,
        updated_by: actor.name,
        updated_at: now
      });
    }

    const logId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: `group:${group.key}`,
      course_name: after,
      action_type: '대표과정명변경',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      notes: `대표과정명 변경 · ${before} → ${after} · 모든 차수와 출고표시 동기화`
    });

    await batch.commit();
    return true;
  }

  async function updateRun(group, course, values, actor) {
    if (!actor?.canManage) throw new Error('차수 수정은 주나연 담당자만 가능합니다.');
    if (!course || course.inventory_ledger_only === true) throw new Error('수정할 차수를 찾을 수 없습니다.');

    const label = clean(values.label);
    const expected = Number(values.expectedQty);
    if (!label) throw new Error('차수/표시명을 입력해주세요. 예: 3차, 7차(1주차)');
    if (!Number.isInteger(expected) || expected < 0) throw new Error('예상 수량은 0권 이상 정수로 입력해주세요.');

    const { fs, db } = await firestoreContext();
    const start = localTimestamp(fs, values.startDate);
    const now = fs.Timestamp.now();
    const batch = fs.writeBatch(db);
    const newCourseName = `${group.name} ${label}`;

    batch.update(fs.doc(db, 'courses', String(course.id)), {
      course_name: newCourseName,
      course_run_label: label,
      inventory_display_name: group.name,
      inventory_only: false,
      inventory_ledger_only: false,
      start_date: start,
      scheduled_release_date: start,
      student_count: expected,
      notes: clean(values.memo),
      updated_by: actor.name,
      updated_at: now
    });

    const logId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: String(course.id),
      course_name: newCourseName,
      action_type: '차수정보수정',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      notes: `차수 정보 수정 · 시작일 ${values.startDate || '미정'} · 예상 ${expected}권`
    });

    await batch.commit();
  }

  async function softDeleteGroup(group, actor, reason) {
    if (!actor?.canManage) throw new Error('과정 삭제는 주나연 담당자만 가능합니다.');
    const { fs, db } = await firestoreContext();
    const batch = fs.writeBatch(db);
    const now = fs.Timestamp.now();

    for (const course of group.courses) {
      batch.update(fs.doc(db, 'courses', String(course.id)), {
        inventory_hidden: true,
        inventory_hidden_at: now,
        inventory_hidden_by: actor.name,
        course_closed_reason: clean(reason) || '폐강/미개강',
        updated_by: actor.name,
        updated_at: now
      });
    }

    const logId = makeId('log');
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: `group:${group.key}`,
      course_name: group.name,
      action_type: '과정삭제',
      action_date: now,
      created_at: now,
      user_name: actor.name,
      user_role: actor.role || '',
      quantity: null,
      notes: `운영목록 삭제(복원 가능) · 사유 ${clean(reason) || '폐강/미개강'} · 삭제 당시 재고 ${group.balance}권 · 과거 입출고 기록 보존`
    });

    await batch.commit();
  }

  window.openCourseManagement = function(groupKey) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    if (!actor?.canManage || !group) return;
    const runs = managedRuns(group);
    const rows = runs.length ? runs.map(c => {
      const label = inferRunLabel(c, group.name) || clean(c.course_name);
      return `<div class="cm-run-row"><div><b>${escSafe(label)}</b><div class="meta">${ymd(c.start_date) || '시작일 미정'} · 예상 ${Math.max(0,n(c.student_count))}권 · 출고 ${Math.max(0,n(c.released_quantity))}권</div></div><button class="btn light small" onclick="openCourseRunEdit('${escSafe(group.key)}','${escSafe(c.id)}')">수정</button></div>`;
    }).join('') : '<div class="empty" style="padding:18px 6px">등록된 차수가 없습니다.</div>';

    openSheet(`<div class="sheet-title">${escSafe(group.name)} 과정 관리</div>
      <div class="sheet-sub">입고 화면에서 대표과정과 차수를 관리하면 출고 화면도 같은 데이터로 자동 반영됩니다.</div>
      <div class="cm-summary"><b>현재 재고 ${group.balance}권</b><span>총 입고 ${group.stock}권 · 총 출고 ${group.released}권</span></div>
      <div class="field"><label>대표과정명</label><input id="cmRepName" value="${escSafe(group.name)}"></div>
      <button id="cmRenameSave" class="btn blue full" style="margin-top:8px">대표과정명 저장 · 출고 동기화</button>
      <div class="section-title" style="margin-top:20px">차수 / 일정</div>
      ${rows}
      <button class="btn light full" style="margin-top:8px" onclick="closeSheet();openAddCourseRun('${escSafe(group.key)}')">＋ 새 차수 추가</button>
      <div class="section-title" style="margin-top:22px;color:#991b1b">폐강 / 미개강 처리</div>
      <button class="btn red full" onclick="openCourseDeleteFirst('${escSafe(group.key)}')">과정 삭제</button>`);

    document.getElementById('cmRenameSave').onclick = async () => {
      const btn = document.getElementById('cmRenameSave');
      btn.disabled = true;
      try {
        const changed = await renameRepresentative(group, document.getElementById('cmRepName').value, actor);
        closeSheet();
        notice(changed ? '대표과정명과 모든 차수명이 동기화되었습니다.' : '변경된 이름이 없습니다.');
        await loadAll();
      } catch (e) {
        notice(e.message || String(e));
        btn.disabled = false;
      }
    };
  };

  window.openCourseRunEdit = function(groupKey, courseId) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    const course = findCourse(courseId);
    if (!actor?.canManage || !group || !course) return;
    const label = inferRunLabel(course, group.name) || clean(course.course_name);
    openSheet(`<div class="sheet-title">차수 정보 수정</div>
      <div class="sheet-sub"><b>${escSafe(group.name)}</b>의 출고 일정에 바로 반영됩니다.</div>
      <div class="field"><label>차수 / 표시명</label><input id="cmRunLabel" value="${escSafe(label)}" placeholder="예: 3차, 7차(1주차)"></div>
      <div class="field"><label>시작일</label><input id="cmRunDate" type="date" value="${ymd(course.start_date || course.scheduled_release_date)}"></div>
      <div class="field"><label>예상 수량</label><input id="cmRunExpected" class="big-number" type="number" inputmode="numeric" min="0" value="${Math.max(0,n(course.student_count))}"></div>
      <div class="field"><label>메모</label><textarea id="cmRunMemo">${escSafe(course.notes || '')}</textarea></div>
      <div class="info-box"><b>시작일을 비우면 주차별 출고 화면에서 빠집니다.</b><br>재고와 기존 출고수량은 변경하지 않습니다.</div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet();openCourseManagement('${escSafe(group.key)}')">취소</button><button id="cmRunSave" class="btn blue">저장</button></div>`);

    document.getElementById('cmRunSave').onclick = async () => {
      const btn = document.getElementById('cmRunSave');
      btn.disabled = true;
      try {
        await updateRun(group, course, {
          label: document.getElementById('cmRunLabel').value,
          startDate: document.getElementById('cmRunDate').value,
          expectedQty: document.getElementById('cmRunExpected').value,
          memo: document.getElementById('cmRunMemo').value
        }, actor);
        closeSheet();
        notice('차수 정보가 수정되어 출고 일정에 반영되었습니다.');
        await loadAll();
      } catch (e) {
        notice(e.message || String(e));
        btn.disabled = false;
      }
    };
  };

  window.openCourseDeleteFirst = function(groupKey) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    if (!actor?.canManage || !group) return;
    const runCount = managedRuns(group).length;
    const balanceTone = group.balance === 0 ? '' : ' style="color:#b91c1c"';
    openSheet(`<div class="sheet-title">과정 삭제 1차 확인</div>
      <div class="sheet-sub"><b>${escSafe(group.name)}</b>을 입고·출고 운영목록에서 제거합니다.</div>
      <div class="warn-box" style="margin-top:14px"><b>현재 재고를 반드시 확인하세요.</b><br><span${balanceTone}>현재 재고 <b>${group.balance}권</b></span><br>등록 차수 ${runCount}개 · 총 입고 ${group.stock}권 · 총 출고 ${group.released}권</div>
      <div class="field"><label>삭제 사유</label><select id="cmDeleteReason"><option>폐강</option><option>미개강</option><option>중복등록</option><option>기타</option></select></div>
      <div class="info-box">실제 데이터와 과거 입·출고 기록은 지우지 않습니다. 필요하면 복원할 수 있습니다.</div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button class="btn red" onclick="openCourseDeleteSecond('${escSafe(group.key)}',document.getElementById('cmDeleteReason').value)">삭제 검토</button></div>`);
  };

  window.openCourseDeleteSecond = function(groupKey, reason) {
    const actor = actorRequired();
    const group = findGroup(groupKey);
    if (!actor?.canManage || !group) return;
    openSheet(`<div class="sheet-title">과정 삭제 최종 확인</div>
      <div class="sheet-sub">이 단계 이후 입고와 주차별 출고 화면에서 즉시 사라집니다.</div>
      <div class="warn-box" style="margin-top:14px"><b>${escSafe(group.name)}</b><br>삭제 사유: ${escSafe(reason)}<br><b style="color:#b91c1c">현재 재고 ${group.balance}권</b></div>
      <div class="field"><label>최종 확인</label><input id="cmDeleteConfirm" placeholder="삭제 를 입력하세요"></div>
      <div class="sheet-actions"><button class="btn light" onclick="closeSheet()">돌아가기</button><button id="cmDeleteFinal" class="btn red" disabled>정말 삭제</button></div>`);

    const input = document.getElementById('cmDeleteConfirm');
    const btn = document.getElementById('cmDeleteFinal');
    input.addEventListener('input', () => { btn.disabled = clean(input.value) !== '삭제'; });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await softDeleteGroup(group, actor, reason);
        closeSheet();
        notice(`${group.name} 삭제 완료 · 과거 기록은 보존됩니다.`);
        await loadAll();
      } catch (e) {
        notice(e.message || String(e));
        btn.disabled = false;
      }
    };
  };

  function addStyles() {
    if (document.getElementById('course-management-style')) return;
    const style = document.createElement('style');
    style.id = 'course-management-style';
    style.textContent = `
      .cm-summary{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:14px;padding:12px 14px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:14px;color:#1e40af}.cm-summary span{font-size:12px}.cm-run-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 0;border-top:1px solid #e2e8f0}.cm-run-row:first-of-type{border-top:0}@media(max-width:430px){.cm-summary{align-items:flex-start;flex-direction:column}.cm-run-row{align-items:stretch;flex-direction:column}.cm-run-row .btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  addStyles();
  window.courseManagementReady = true;
})();
