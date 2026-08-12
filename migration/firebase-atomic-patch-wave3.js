// Wave 3 atomic write overrides for the Firebase migration preview.
// Scope: inventory/release corrections, reset/rollback, force/extra release,
// legacy action modal, course name edit, course create/edit/delete.
(function () {
  'use strict';

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
      try {
        const writeService = await window.firebaseWriteServiceReady;

        function actorReady() {
          if (typeof requireUser === 'function' && !requireUser()) return false;
          if (!currentUser) {
            showNotification('작업자를 먼저 선택해주세요.', 'error');
            return false;
          }
          return true;
        }

        async function refreshAll() {
          await loadCourses();
          if (typeof loadStockManagement === 'function') await loadStockManagement();
          await loadDashboardData();
          if (typeof updateStockInventoryTable === 'function') updateStockInventoryTable();
          if (typeof renderAdminCoursesList === 'function') renderAdminCoursesList();
        }

        window.submitGroupStockEdit = async function submitGroupStockEditAtomic() {
          if (!actorReady()) return;
          const groupKey = document.getElementById('group-manage-group-name').value;
          const displayName = (() => {
            const c = courses.find(x => getGroupKey(x.course_name) === groupKey);
            return c ? getGroupName(c.course_name) : groupKey;
          })();
          const qtyInput = document.getElementById('group-stock-edit-quantity').value;
          const notes = document.getElementById('group-stock-edit-notes').value.trim();
          const current = parseInt(document.getElementById('group-stock-edit-current').dataset.current) || 0;
          if (qtyInput === '') { showNotification('수정할 재고 수량을 입력해주세요.', 'error'); return; }
          const newTotal = parseInt(qtyInput);
          if (isNaN(newTotal) || newTotal < 0) { showNotification('올바른 수량을 입력해주세요.', 'error'); return; }
          if (!notes) { showNotification('수정 사유를 입력해주세요.', 'error'); return; }
          if (newTotal === current) { showNotification('현재 재고와 동일합니다.', 'info'); return; }
          const diff = newTotal - current;
          const diffText = diff > 0 ? `+${diff}권` : `${diff}권`;
          if (!confirm(`✏️ 재고 수정 확인\n\n그룹: ${displayName}\n현재: ${current}권 → 수정: ${newTotal}권 (${diffText})\n사유: ${notes}\n\n진행하시겠습니까?`)) return;

          const groupCourses = courses.filter(c => getGroupKey(c.course_name) === groupKey)
            .sort((a,b) => new Date(a.start_date) - new Date(b.start_date));
          const target = groupCourses.find(c => (c.stock_quantity || 0) > 0) || groupCourses[0];
          if (!target) { showNotification('대상 과정을 찾을 수 없습니다.', 'error'); return; }
          const targetNewStock = Math.max(0, (target.stock_quantity || 0) + diff);
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId: target.id, expectedStatus: target.status, actor: currentUser,
              updates: { stock_quantity: targetNewStock, updated_at: now },
              log: { course_name: target.course_name, action_type: '수정', action_date: now,
                quantity: Math.abs(diff), previous_status: target.status, new_status: target.status,
                notes: `재고 수정 (${diffText}) — 그룹 총 재고 ${current}권→${newTotal}권 / 사유: ${notes}` }
            });
            showNotification(`재고 수정 완료! ${displayName}: ${current}권 → ${newTotal}권 (${diffText})`, 'success');
            await refreshAll();
            const ts = getGroupTotalStock(groupKey);
            const el = document.getElementById('group-stock-edit-current');
            if (el) { el.textContent = `${ts}권`; el.dataset.current = ts; }
            const q = document.getElementById('group-stock-edit-quantity'); if (q) q.value = '';
            const d = document.getElementById('group-stock-edit-diff'); if (d) d.textContent = '';
          } catch (e) { console.error(e); showNotification(`재고 수정 실패: ${e.message || e}`, 'error'); }
        };

        window.submitReleaseQtyEdit = async function submitReleaseQtyEditAtomic(courseId, courseName, currentStatus) {
          if (!actorReady()) return;
          const safeId = courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
          const input = document.getElementById(`release-qty-${safeId}`);
          if (!input) return;
          const newQty = parseInt(input.value);
          if (isNaN(newQty) || newQty < 0) { showNotification('올바른 수량을 입력해주세요.', 'error'); return; }
          const course = courses.find(c => c.id === courseId);
          if (!course) return;
          const oldQty = course.released_quantity || 0;
          if (newQty === oldQty) { showNotification('현재 출고량과 동일합니다.', 'info'); return; }
          if (!confirm(`✏️ 출고량 수정 확인\n\n과정: ${courseName}\n${oldQty}권 → ${newQty}권\n상태(${currentStatus})는 유지됩니다.\n\n진행하시겠습니까?`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { released_quantity: newQty, updated_at: now },
              log: { course_name: course.course_name, action_type: '수정', action_date: now,
                previous_status: course.status, new_status: course.status,
                notes: `출고량 수정 ${oldQty}권 → ${newQty}권` }
            });
            showNotification(`출고량 수정 완료! ${courseName}: ${oldQty}권 → ${newQty}권`, 'success');
            await refreshAll();
            const groupKey = document.getElementById('group-manage-group-name')?.value;
            if (groupKey && typeof _renderReleaseEditList === 'function') _renderReleaseEditList(groupKey);
          } catch(e) { console.error(e); showNotification(`출고량 수정 실패: ${e.message || e}`, 'error'); }
        };

        window.submitStockOutEdit = async function submitStockOutEditAtomic() {
          if (!actorReady()) return;
          const courseId = document.getElementById('stock-out-edit-course-id').value;
          const input = document.getElementById('stock-out-edit-quantity');
          const newQty = parseInt(input.value);
          const stock = parseInt(input.dataset.stock) || 0;
          const notes = document.getElementById('stock-out-edit-notes').value || '출고 수량 수정';
          if (isNaN(newQty) || newQty < 1) { showNotification('올바른 수량을 입력해주세요.', 'error'); return; }
          if (newQty > stock) { showNotification(`출고 수량(${newQty})이 현재 재고(${stock})를 초과합니다.`, 'error'); return; }
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const oldQty = course.released_quantity ?? course.student_count ?? 0;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { released_quantity: newQty, updated_at: now },
              log: { course_name: course.course_name, action_type: '수정', action_date: now,
                quantity: newQty, previous_status: course.status, new_status: course.status,
                notes: `출고 수량 수정: ${oldQty}권 → ${newQty}권 / 잔여: ${stock - newQty}권 (${notes})` }
            });
            showNotification(`출고 수량이 ${newQty}권으로 수정되었습니다. (잔여 ${stock - newQty}권)`, 'success');
            closeStockOutEditModal(); await refreshAll();
          } catch(e) { console.error(e); showNotification(`수정 실패: ${e.message || e}`, 'error'); }
        };

        window.submitStockEdit = async function submitStockEditAtomic() {
          if (!actorReady()) return;
          const courseId = document.getElementById('stock-edit-course-id').value;
          const newQty = parseInt(document.getElementById('stock-edit-quantity').value);
          const notes = document.getElementById('stock-edit-notes').value || '입고 수량 수정';
          if (isNaN(newQty) || newQty < 1) { showNotification('올바른 수량을 입력해주세요.', 'error'); return; }
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const oldQty = course.stock_quantity ?? 0;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { stock_quantity: newQty, updated_at: now },
              log: { course_name: course.course_name, action_type: '수정', action_date: now,
                quantity: newQty, previous_status: course.status, new_status: course.status,
                notes: `입고 수량 수정: ${oldQty}권 → ${newQty}권 (${notes})` }
            });
            showNotification(`입고 수량이 ${newQty}권으로 수정되었습니다.`, 'success');
            closeStockEditModal(); await refreshAll();
          } catch(e) { console.error(e); showNotification(`수정 실패: ${e.message || e}`, 'error'); }
        };

        window.confirmReleaseReset = async function confirmReleaseResetAtomic(courseId, courseName, currentStatus, releasedQty) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const msg = `🔄 출고 초기화 확인\n\n과정: ${courseName}\n현재 상태: ${currentStatus}\n출고 수량: ${releasedQty}권\n\n→ 상태가 [입고완료]로 돌아가며 다시 출고 처리할 수 있습니다.\n이력은 모두 보존됩니다.\n\n진행하시겠습니까?`;
          if (!confirm(msg)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { status: '입고완료', released_quantity: 0, actual_release_date: null,
                confirmed_by: null, confirmed_at: null, updated_at: now },
              log: { course_name: course.course_name, action_type: '수정', action_date: now,
                previous_status: course.status, new_status: '입고완료',
                notes: `출고 초기화 — 출고 ${releasedQty}권 취소, 입고완료 상태로 복원 (재출고 가능)` }
            });
            showNotification(`출고 초기화 완료 — ${courseName} 다시 출고 처리할 수 있습니다.`, 'success');
            await refreshAll();
            const groupKey = document.getElementById('group-manage-group-name')?.value;
            if (groupKey && typeof _renderReleaseEditList === 'function') _renderReleaseEditList(groupKey);
            if (typeof renderStockLists === 'function') renderStockLists();
          } catch(e) { console.error(e); showNotification(`출고 초기화 실패: ${e.message || e}`, 'error'); }
        };

        window.submitCourseNameEdit = async function submitCourseNameEditAtomic(courseId) {
          if (!actorReady()) return;
          const input = document.getElementById(`name-edit-input-${courseId}`);
          const newName = input?.value.trim();
          const course = courses.find(c => c.id === courseId); if (!course) return;
          if (!newName) { showNotification('❗ 과정명을 입력해주세요.', 'error'); return; }
          const oldName = course.course_name;
          if (newName === oldName) { showNotification('변경된 내용이 없습니다.', 'info'); return; }
          const confirmed = await showConfirmModal('✏️ 과정명 변경', `변경 전: ${oldName}\n변경 후: ${newName}\n\n이 작업은 DB에 즉시 저장됩니다.`, '💾 저장', '#4f46e5');
          if (!confirmed) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { course_name: newName, updated_by: currentUser.name, updated_at: now },
              log: { course_name: newName, action_type: '수정', action_date: now,
                previous_status: course.status, new_status: course.status,
                notes: `과정명 변경: "${oldName}" → "${newName}"` }
            });
            showNotification(`✅ 과정명이 "${newName}"으로 변경되었습니다.`, 'success');
            await refreshAll();
            if (typeof renderStockLists === 'function') renderStockLists();
            if (typeof closeGroupManageModal === 'function') closeGroupManageModal();
          } catch(e) { console.error(e); showNotification(`❗ 수정 실패: ${e.message || e}`, 'error'); }
        };

        window.submitForceRelease = async function submitForceReleaseAtomic(courseId, courseName) {
          if (!actorReady()) return;
          const safeId = courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
          const input = document.getElementById(`force-qty-${safeId}`); if (!input) return;
          const outQty = parseInt(input.value);
          const groupKey = document.getElementById('force-release-group-key').value;
          if (isNaN(outQty) || outQty < 1) { showNotification('출고 수량을 입력해주세요.', 'error'); return; }
          const totalStock = getGroupTotalStock(groupKey);
          const totalReleased = getGroupTotalReleased(groupKey, courseId);
          const avail = totalStock - totalReleased;
          if (outQty > avail) { showNotification(`가용 재고(${avail}권)를 초과할 수 없습니다.`, 'error'); return; }
          const course = courses.find(c => c.id === courseId); if (!course) return;
          if (!confirm(`📤 출고 처리 확인\n\n과정: ${courseName}\n출고 수량: ${outQty}권\n출고 후 그룹 잔여: ${avail - outQty}권\n\n진행하시겠습니까?`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId, expectedStatus: course.status, actor: currentUser,
              updates: { status: '출고완료', released_quantity: outQty, actual_release_date: now, updated_at: now },
              log: { course_name: course.course_name, action_type: '출고', action_date: now,
                quantity: outQty, previous_status: course.status, new_status: '출고완료',
                notes: `출고 ${outQty}권 / 그룹 잔여 ${avail - outQty}권` }
            });
            showNotification(`출고 완료! ${courseName} — ${outQty}권`, 'success'); await refreshAll();
            if (typeof _renderForceReleaseList === 'function') _renderForceReleaseList(groupKey);
            if (typeof renderStockLists === 'function') renderStockLists();
          } catch(e) { console.error(e); showNotification(`출고 처리 실패: ${e.message || e}`, 'error'); }
        };

        window.submitExtraRelease = async function submitExtraReleaseAtomic() {
          if (!actorReady()) return;
          const courseId = document.getElementById('extra-release-course-id').value;
          const input = document.getElementById('extra-release-quantity');
          const extraQty = parseInt(input.value);
          const stock = parseInt(input.dataset.stock) || 0;
          const released = parseInt(input.dataset.released) || 0;
          const notes = document.getElementById('extra-release-notes').value.trim();
          if (isNaN(extraQty) || extraQty < 1) { showNotification('추가 출고 수량을 입력해주세요.', 'error'); return; }
          if (!notes) { showNotification('출고 사유를 입력해주세요.', 'error'); return; }
          if (extraQty > stock - released) { showNotification(`잔여 수량(${stock - released}권)을 초과할 수 없습니다.`, 'error'); return; }
          const course = courses.find(c => c.id === courseId); if (!course) return;
          if (!confirm(`📤 추가 출고 확인\n\n과정: ${course.course_name}\n추가 출고: ${extraQty}권\n사유: ${notes}\n\n진행하시겠습니까?`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.logOnly({ courseId, actor: currentUser,
              log: { course_name: course.course_name, action_type: '추가출고', action_date: now,
                quantity: extraQty, previous_status: course.status, new_status: course.status,
                notes: `추가출고 ${extraQty}권 / 사유: ${notes} / 잔여: ${stock - released - extraQty}권` } });
            showNotification(`추가 출고 완료! ${extraQty}권 (잔여 ${stock - released - extraQty}권)`, 'success');
            closeExtraReleaseModal();
          } catch(e) { console.error(e); showNotification(`추가 출고 실패: ${e.message || e}`, 'error'); }
        };

        window.handleActionSubmit = async function handleActionSubmitAtomic(e) {
          e?.preventDefault?.();
          if (!actorReady()) return;
          const courseId = document.getElementById('action-course-id').value;
          const actionType = document.getElementById('action-type').value;
          const quantity = parseInt(document.getElementById('action-quantity').value);
          const notes = document.getElementById('action-notes').value;
          if (!courseId) { showNotification('과정 정보를 찾을 수 없습니다.', 'error'); return; }
          if (actionType === '입고' && (isNaN(quantity) || quantity < 0)) { showNotification('수량을 0 이상으로 입력해주세요.', 'error'); return; }
          if (actionType !== '입고' && (isNaN(quantity) || quantity < 1)) { showNotification('수량을 올바르게 입력해주세요.', 'error'); return; }
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const now = new Date().toISOString();
          const updates = { updated_at: now };
          if (actionType === '입고') { updates.stock_quantity = quantity; updates.status = '입고완료'; }
          else { updates.status = '출고완료'; updates.actual_release_date = now; updates.released_quantity = quantity; }
          try {
            await writeService.updateCourseWithLog({ courseId, expectedStatus: course.status, actor: currentUser, updates,
              log: { course_name: course.course_name, action_type: actionType, action_date: now, quantity,
                previous_status: course.status, new_status: updates.status,
                notes: notes || (actionType === '입고' && quantity === 0 ? '0 입고 — 통합재고 활용' : '') } });
            showNotification(actionType === '입고' && quantity === 0 ? '0권 입고 처리 완료 — 통합재고 활용' : `${actionType} 처리가 완료되었습니다.`, actionType === '입고' && quantity === 0 ? 'info' : 'success');
            closeActionModal(); await refreshAll();
          } catch(e2) { console.error(e2); showNotification(`작업 처리 실패: ${e2.message || e2}`, 'error'); }
        };

        window.adminRollback = async function adminRollbackAtomic(courseId, currentStatus) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const flow = ['입고대기','입고완료','출고완료','출고확인','세팅중','세팅완료대기','세팅완료'];
          const idx = flow.indexOf(currentStatus);
          if (idx <= 0) { showNotification('더 이상 롤백할 수 없습니다.', 'error'); return; }
          const prevOptions = flow.slice(0, idx).reverse();
          const optionText = prevOptions.map((s,i) => `${i+1}. ${s}`).join('\n');
          const input = prompt(`📋 롤백 — ${course.course_name}\n현재 상태: ${currentStatus}\n\n롤백할 단계 번호를 입력하세요:\n${optionText}\n\n예: 1 / 수량 오류 재처리`);
          if (!input) return;
          const parts = input.split('/').map(s => s.trim());
          const num = parseInt(parts[0]); const reason = parts[1] || '관리자 롤백';
          if (isNaN(num) || num < 1 || num > prevOptions.length) { showNotification('올바른 번호를 입력해주세요.', 'error'); return; }
          const targetStatus = prevOptions[num - 1];
          if (!confirm(`⚠️ 롤백 확인\n\n과정: ${course.course_name}\n${currentStatus} → ${targetStatus}\n사유: ${reason}\n\n계속하시겠습니까?`)) return;
          const now = new Date().toISOString();
          const updates = { status: targetStatus, updated_at: now, updated_by: currentUser.name };
          if (targetStatus === '입고대기') { updates.stock_quantity = 0; updates.released_quantity = null; }
          if (['입고완료','입고대기'].includes(targetStatus)) { updates.released_quantity = null; updates.confirmed_by = null; updates.confirmed_at = null; }
          if (!['세팅완료'].includes(targetStatus)) updates.setup_complete_date = null;
          try {
            await writeService.updateCourseWithLog({ courseId, expectedStatus: course.status, actor: currentUser, updates,
              log: { course_name: course.course_name, action_type: '롤백', action_date: now,
                previous_status: course.status, new_status: targetStatus,
                notes: `🔙 관리자 롤백: ${course.status} → ${targetStatus} / 사유: ${reason}` } });
            showNotification(`✅ 롤백 완료: ${currentStatus} → ${targetStatus}`, 'success'); await refreshAll();
          } catch(e) { console.error(e); showNotification(`롤백 실패: ${e.message || e}`, 'error'); }
        };

        const legacyHandleCourseSubmit = window.handleCourseSubmit;
        const courseForm = document.getElementById('course-form');
        if (courseForm && typeof legacyHandleCourseSubmit === 'function') courseForm.removeEventListener('submit', legacyHandleCourseSubmit);

        window.handleCourseSubmit = async function handleCourseSubmitAtomic(e) {
          e?.preventDefault?.();
          if (!currentUser) {
            const saved = localStorage.getItem('textbook_last_user');
            const name = saved || document.getElementById('current-user')?.value?.trim();
            if (name) currentUser = users.find(u => u.name === name) || FALLBACK_USERS.find(u => u.name === name) || {name,role:'관리자',active:true};
          }
          if (!currentUser) { showNotification('작업자를 먼저 선택해주세요.', 'error'); return; }
          const id = document.getElementById('course-id').value;
          const safeDate = (fieldId) => { const val = document.getElementById(fieldId)?.value; if (!val) return null; const d = new Date(val); return isNaN(d.getTime()) ? null : d.toISOString(); };
          const courseName = document.getElementById('course-name').value.trim();
          const startDate = safeDate('course-start-date');
          const studentCount = parseInt(document.getElementById('course-students').value) || 0;
          if (!courseName) { showNotification('❗ 과정명을 입력해주세요.', 'error'); return; }
          if (!startDate) { showNotification('❗ 시작일을 선택해주세요.', 'error'); return; }
          if (studentCount <= 0) { showNotification('❗ 수강 인원을 입력해주세요. (1명 이상)', 'error'); return; }
          const now = new Date().toISOString();
          const common = { course_name: courseName, start_date: startDate, end_date: safeDate('course-end-date'), student_count: studentCount,
            stock_quantity: parseInt(document.getElementById('course-stock').value) || 0,
            scheduled_release_date: safeDate('course-release-date'), classroom: document.getElementById('course-classroom').value.trim(),
            notes: document.getElementById('course-notes').value.trim(), updated_by: currentUser.name, updated_at: now };
          const submitBtn = document.querySelector('#course-form button[type="submit"]');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '저장 중...'; }
          try {
            if (id) {
              const existing = courses.find(c => c.id === id); if (!existing) throw new Error('기존 과정 정보를 찾을 수 없습니다.');
              await writeService.updateCourseWithLog({ courseId: id, expectedStatus: existing.status, actor: currentUser, updates: common,
                log: { course_name: courseName, action_type: '수정', action_date: now,
                  previous_status: existing.status, new_status: existing.status, notes: `과정 수정: ${courseName}` } });
              showNotification(`✅ "${courseName}" 수정 완료`, 'success');
            } else {
              const newId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
              const course = { id:newId, ...common, released_quantity:0, status:'입고대기', created_by:currentUser.name, created_at:now };
              await writeService.insertCourseWithLog({ course, actor:currentUser,
                log:{ course_name:courseName, action_type:'추가', action_date:now, previous_status:null, new_status:'입고대기', notes:`과정 추가: ${courseName}` } });
              showNotification(`✅ "${courseName}" 추가 완료!`, 'success');
            }
            closeCourseModal(); await refreshAll();
          } catch(err) { console.error(err); showNotification(`❗ 저장 실패: ${err.message || err}`, 'error'); }
          finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 저장'; } }
        };
        if (courseForm) courseForm.addEventListener('submit', window.handleCourseSubmit);

        window.deleteCourse = async function deleteCourseAtomic(id) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === id); if (!course) return;
          if (!confirm('정말 삭제하시겠습니까?\n삭제된 과정은 복구할 수 없습니다.')) return;
          try {
            const now = new Date().toISOString();
            await writeService.deleteCourseWithLog({ courseId:id, expectedStatus:course.status, actor:currentUser,
              log:{ course_name:course.course_name, action_type:'삭제', action_date:now, previous_status:course.status, new_status:'삭제됨', notes:`과정 삭제: ${course.course_name}` } });
            showNotification('과정이 삭제되었습니다.', 'success'); await refreshAll();
          } catch(e) { console.error(e); showNotification(`삭제 실패: ${e.message || e}`, 'error'); }
        };

        window.deleteAdminCourse = async function deleteAdminCourseAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId); if (!course) return;
          const confirmed = await showConfirmModal('⚠️ 과정 삭제', `"${course.course_name}" 과정을 삭제하시겠습니까?\n\n이 작업은 취소할 수 없습니다.`, '🗑️ 삭제', '#dc2626');
          if (!confirmed) return;
          try {
            const now = new Date().toISOString();
            await writeService.deleteCourseWithLog({ courseId, expectedStatus:course.status, actor:currentUser,
              log:{ course_name:course.course_name, action_type:'삭제', action_date:now, previous_status:course.status, new_status:'삭제됨', notes:`과정 삭제: ${course.course_name}` } });
            showNotification(`✅ "${course.course_name}" 삭제 완료`, 'success'); await refreshAll();
          } catch(e) { console.error(e); showNotification(`❗ 삭제 실패: ${e.message || e}`, 'error'); }
        };

        window.__mgAtomicPatchWave3Ready = true;
        window.__mgAtomicPatchVersion = 'wave3';
        console.info('[Firebase Migration] Atomic patch wave3 enabled: corrections, reset/rollback, course CRUD');
      } catch(e) {
        console.error('[Firebase Migration] Atomic patch wave3 init failed', e);
        window.__mgAtomicPatchWave3Ready = false;
      }
    }, 0);
  });
})();
