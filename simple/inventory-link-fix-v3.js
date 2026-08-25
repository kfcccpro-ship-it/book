// Runtime inventory-link repair v3.
// Purpose: repair known PF course <-> textbook linkage immediately after first load,
// then run a conservative cross-course consistency audit. Never changes stock counts.
(function () {
  'use strict';

  const REPORT = { repaired: [], warnings: [], ready: false };
  window.inventoryConsistencyReportV3 = REPORT;

  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const n = value => {
    const x = Number(value || 0);
    return Number.isFinite(x) ? x : 0;
  };
  const norm = value => clean(value).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');

  function isPfCourse(course) {
    const name = clean(course?.course_name);
    return /pf\s*관련\s*실무/i.test(name) || (/pf/i.test(name) && /1day/i.test(name));
  }

  function isPfInventoryGroup(group) {
    const name = clean(group?.name);
    return /부동산.*pf.*대출.*법률리스크.*대응전략/i.test(name);
  }

  function courseOriginalGroup(course) {
    try {
      const key = String(course?.inventory_group_key || '').replace(/\s+/g, '').toLowerCase();
      if (key) return state.groups.find(g => g.key === key) || null;
      return null;
    } catch (_) { return null; }
  }

  function pfTargetGroup() {
    try {
      const groups = state.groups.filter(g => isPfInventoryGroup(g) && n(g.balance) > 0);
      // Automatic repair is allowed only when exactly one positive-balance PF inventory group exists.
      return groups.length === 1 ? groups[0] : null;
    } catch (_) { return null; }
  }

  async function firestoreContext() {
    const [fs, client] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js'),
      window.firebaseDbReady
    ]);
    return { fs, db: client.firebase.db };
  }

  async function persistPfLinkRepair() {
    const target = pfTargetGroup();
    if (!target || target.balance <= 0) return false;
    const courses = state.courses.filter(c => c.inventory_only !== true && isPfCourse(c));
    const candidates = courses.filter(course => {
      const current = courseOriginalGroup(course);
      return current && current.key !== target.key && n(current.balance) === 0;
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
        inventory_link_repaired_reason: 'PF 과정과 주교재 재고 그룹 연결 정합성 복구 v3',
        updated_at: now,
        updated_by: '재고정합성점검-v3'
      });
    }
    const logId = `log_linkfix_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    batch.set(fs.doc(db, 'work_logs', logId), {
      id: logId,
      course_id: candidates.map(c => String(c.id)).join(','),
      course_name: candidates.map(c => clean(c.course_name)).join(' / '),
      action_type: '연결수정',
      action_date: now,
      created_at: now,
      user_name: '재고정합성점검-v3',
      user_role: '자동 연결 복구',
      quantity: null,
      notes: `재고 수량 변경 없음 · PF 과정 ${candidates.length}건을 ${target.name} 재고그룹(${target.balance}권)으로 연결`
    });
    await batch.commit();
    REPORT.repaired.push({
      type: 'pf-link',
      courses: candidates.map(c => clean(c.course_name)),
      target: target.name,
      balance: target.balance
    });
    return true;
  }

  function significantTokens(value) {
    return clean(value).toLowerCase()
      .replace(/(제\s*)?\d+\s*차/g, ' ')
      .split(/[^0-9a-z가-힣]+/)
      .filter(t => t.length >= 2 && !['과정','교육','실무','클래스','기본','관련','day'].includes(t));
  }

  function scoreNames(a, b) {
    const A = significantTokens(a), B = significantTokens(b);
    if (!A.length || !B.length) return 0;
    let hit = 0;
    for (const token of A) {
      if (B.some(other => other === token || (token.length >= 4 && (token.includes(other) || other.includes(token))))) hit++;
    }
    return hit / Math.max(A.length, B.length);
  }

  function runConsistencyAudit() {
    const warnings = [];
    const groups = state.groups || [];
    const courses = (state.courses || []).filter(c => c.inventory_only !== true && c.inventory_ledger_only !== true);

    // 1. Multiple groups with effectively the same display name.
    const sameName = new Map();
    for (const group of groups) {
      const key = norm(group.name);
      if (!key) continue;
      if (!sameName.has(key)) sameName.set(key, []);
      sameName.get(key).push(group);
    }
    for (const list of sameName.values()) {
      if (list.length > 1) warnings.push({ type:'duplicate-group', text:`동일 교재명이 ${list.length}개 재고그룹으로 분리: ${list[0].name}` });
    }

    // 2. Only zero-balance groups are link-repair candidates. Negative balances are a separate physical-inventory issue.
    for (const course of courses) {
      const current = courseOriginalGroup(course);
      if (!current || n(current.balance) !== 0) continue;
      const positive = groups
        .filter(g => g.key !== current.key && g.balance > 0)
        .map(g => ({ g, score: scoreNames(course.course_name, g.name) }))
        .filter(x => x.score >= 0.45)
        .sort((a,b) => b.score - a.score);
      if (positive.length && (positive.length === 1 || positive[0].score > positive[1].score + 0.2)) {
        warnings.push({
          type:'possible-link',
          courseId:String(course.id),
          text:`${clean(course.course_name)}: 현재 연결 재고 0권 / 유사 재고 ${positive[0].g.name} ${positive[0].g.balance}권`
        });
      }
    }

    // 3. Sub-books whose parent group cannot be found.
    for (const book of (state.subBooks || []).filter(b => b.inventory_hidden !== true)) {
      const key = String(book.course_group_key || '');
      const groupName = norm(book.course_group_name || '');
      const found = groups.some(g => (key && g.key === key) || (groupName && norm(g.name) === groupName));
      if (!found) warnings.push({ type:'orphan-sub', text:`부교재 부모 과정 연결 확인 필요: ${clean(book.inventory_display_name || book.book_name || '부교재')}` });
    }

    REPORT.warnings = warnings;
    REPORT.ready = true;
    console.info('[재고정합성점검-v3]', REPORT);
    return warnings;
  }

  function showAuditBadge() {
    const host = document.getElementById('integrityAlert');
    if (!host || host.querySelector('.v3-inventory-audit')) return;
    if (!REPORT.repaired.length && !REPORT.warnings.length) return;
    const box = document.createElement('div');
    box.className = 'v2-audit v3-inventory-audit';
    const fixed = REPORT.repaired.length
      ? `<b>재고 연결 복구 완료</b><br>${REPORT.repaired.map(r => `${r.courses.join(', ')} → ${r.target} (${r.balance}권)`).join('<br>')}<br>`
      : '';
    const warn = REPORT.warnings.length
      ? `<b>다른 과정 연결 점검 ${REPORT.warnings.length}건</b><br>${REPORT.warnings.slice(0,4).map(w => `• ${w.text}`).join('<br>')}${REPORT.warnings.length > 4 ? `<br>외 ${REPORT.warnings.length-4}건` : ''}`
      : '<b>다른 과정의 명확한 연결 이상은 발견되지 않았습니다.</b>';
    box.innerHTML = fixed + warn;
    host.appendChild(box);
  }

  async function refreshAfterRepair() {
    if (typeof loadAll === 'function') {
      await loadAll();
      return;
    }
    if (typeof rebuildGroups === 'function') rebuildGroups();
    if (typeof renderAll === 'function') renderAll();
  }

  async function executeWhenReady() {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (window.state && Array.isArray(state.courses) && state.courses.length && Array.isArray(state.groups) && state.groups.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!window.state || !state.courses?.length || !state.groups?.length) return;

    let repaired = false;
    try {
      repaired = await persistPfLinkRepair();
    } catch (error) {
      // Fail closed: keep both inbound and outbound on the same persisted source of truth.
      console.error('[PF 재고 연결 영구복구 실패]', error);
      REPORT.warnings.push({ type:'pf-write-failed', text:`PF 연결 영구복구 실패: ${error.message || error}` });
    }

    if (repaired) {
      try { await refreshAfterRepair(); } catch (error) { console.warn('재고 연결 복구 후 재로딩 실패', error); }
    } else {
      try {
        if (typeof rebuildGroups === 'function') rebuildGroups();
        if (typeof renderAll === 'function') renderAll();
      } catch (_) {}
    }

    runConsistencyAudit();
    showAuditBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', executeWhenReady, { once:true });
  else executeWhenReady();
})();
