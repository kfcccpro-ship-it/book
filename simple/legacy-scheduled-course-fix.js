// One-time compatibility repair for a legacy inventory item that was later given a course schedule.
// Exact target only: 뉴MG커뮤니케이션스킬.
// Preserves stock/release quantities and existing inventory_group_key.
(function () {
  'use strict';

  const FIX = { installed: false, repaired: false, warning: null };
  window.legacyScheduledCourseFix = FIX;

  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const norm = value => clean(value).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
  const TARGET = norm('뉴MG커뮤니케이션스킬');

  function isTarget(course) {
    return norm(course?.course_name) === TARGET || norm(course?.inventory_display_name) === TARGET;
  }

  async function firestoreContext() {
    const [fs, client] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js'),
      window.firebaseDbReady
    ]);
    return { fs, db: client.firebase.db };
  }

  async function repairIfNeeded() {
    const rows = (state.courses || []).filter(isTarget);
    if (!rows.length) return false;

    const candidates = rows.filter(course =>
      course.inventory_only === true || !course.start_date || course.inventory_ledger_only === true
    );
    if (!candidates.length) return false;

    if (candidates.length !== 1) {
      FIX.warning = `뉴MG커뮤니케이션스킬 보정 대상이 ${candidates.length}건이라 자동수정을 중단했습니다.`;
      console.error('[뉴MG커뮤니케이션스킬 보정 중단]', { rows, candidates });
      return false;
    }

    const course = candidates[0];
    const schedule = course.start_date || course.scheduled_release_date;
    if (!schedule) {
      FIX.warning = '뉴MG커뮤니케이션스킬에 저장된 시작일/출고예정일이 없어 자동수정을 중단했습니다.';
      console.error('[뉴MG커뮤니케이션스킬 일정 없음]', course);
      return false;
    }

    const { fs, db } = await firestoreContext();
    const now = fs.Timestamp.now();
    const batch = fs.writeBatch(db);
    batch.update(fs.doc(db, 'courses', String(course.id)), {
      inventory_only: false,
      inventory_ledger_only: false,
      inventory_item_type: '주교재',
      start_date: schedule,
      scheduled_release_date: schedule,
      updated_at: now,
      updated_by: 'legacy-scheduled-course-fix'
    });

    const logId = `log_schedulefix_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: String(course.id),
      course_name: course.course_name || course.inventory_display_name || '뉴MG커뮤니케이션스킬',
      action_type: '과정성격보정',
      action_date: now,
      created_at: now,
      user_name: '시스템 보정',
      user_role: '기존 재고항목의 주차출고 정상화',
      quantity: null,
      notes: '재고 수량/출고 수량/교재 연결은 변경하지 않고, 기존 저장 일정으로 주차 출고 대상 과정 성격만 정상화'
    });

    await batch.commit();
    FIX.repaired = true;
    console.info('[뉴MG커뮤니케이션스킬 주차 출고 정상화 완료]', {
      id: course.id,
      schedule,
      inventory_group_key: course.inventory_group_key,
      stock_quantity: course.stock_quantity,
      released_quantity: course.released_quantity
    });
    return true;
  }

  function install() {
    if (FIX.installed) return;
    if (typeof window.loadAll !== 'function' || !window.courseWorkflowSimpleV3?.installed) {
      setTimeout(install, 25);
      return;
    }

    const priorLoadAll = window.loadAll;
    window.loadAll = async function () {
      await priorLoadAll();
      const repaired = await repairIfNeeded();
      if (repaired) await priorLoadAll();
      if (FIX.warning && typeof notice === 'function') notice(FIX.warning);
    };
    FIX.installed = true;
  }

  install();
})();
