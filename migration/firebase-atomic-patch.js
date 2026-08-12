// Atomic write overrides for the Firebase migration preview.
// Converted scope:
// 1) group stock-in
// 2) stock-out
// 3) stock-in approval
// 4) stock-out approval log
// 5) stock-out confirmation
// 6) setup start
// 7) setup completion request
// 8) final setup confirmation
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

        async function refreshCore() {
          await loadCourses();
          if (typeof loadStockManagement === 'function') await loadStockManagement();
          await loadDashboardData();
        }

        window.submitGroupStockIn = async function submitGroupStockInAtomic() {
          if (!actorReady()) return;
          const groupKey = document.getElementById('group-stock-in-group-name').value;
          const displayName = (() => {
            const c = courses.find(x => getGroupKey(x.course_name) === groupKey);
            return c ? getGroupName(c.course_name) : groupKey;
          })();
          const qtyInput = document.getElementById('group-stock-in-quantity').value;
          const notes = document.getElementById('group-stock-in-notes').value.trim();
          const inDate = document.getElementById('group-stock-in-date').value || new Date().toISOString().split('T')[0];

          if (qtyInput === '' || qtyInput === null) { showNotification('입고 수량을 입력해주세요.', 'error'); return; }
          const qty = parseInt(qtyInput);
          if (isNaN(qty) || qty < 0) { showNotification('올바른 수량을 입력해주세요.', 'error'); return; }

          const groupCourses = courses
            .filter(c => getGroupKey(c.course_name) === groupKey)
            .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
          if (groupCourses.length === 0) { showNotification('해당 그룹의 과정을 찾을 수 없습니다.', 'error'); return; }
          const target = groupCourses.find(c => c.status === '입고대기') || groupCourses[0];

          const confirmText = qty === 0
            ? `📦 입고 수량 0권으로 입고 처리합니다.\n\n그룹: ${displayName}\n입고일: ${inDate}\n대상 과정: ${target.course_name}\n\n재고 없이 상태만 입고완료로 변경됩니다. 진행하시겠습니까?`
            : `📦 입고 처리 확인\n\n그룹: ${displayName}\n입고일: ${inDate}\n대상 과정: ${target.course_name}\n입고 수량: ${qty}권\n${notes ? '비고: ' + notes : ''}\n\n진행하시겠습니까?`;
          if (!confirm(confirmText)) return;

          try {
            const newStock = (target.stock_quantity || 0) + qty;
            const newStatus = target.status === '입고대기' ? '입고완료' : target.status;
            const inDateISO = new Date(inDate + 'T09:00:00').toISOString();
            const now = new Date().toISOString();
            const logNote = qty === 0
              ? `입고 0권 처리 (재고 없음) / 입고일: ${inDate}${notes ? ' / ' + notes : ''}`
              : `입고 ${qty}권 (누적 재고 ${newStock}권) / 입고일: ${inDate}${notes ? ' / ' + notes : ''}`;

            await writeService.updateCourseWithLog({
              courseId: target.id,
              expectedStatus: target.status,
              actor: currentUser,
              updates: { stock_quantity: newStock, status: newStatus, updated_at: now },
              log: {
                course_name: target.course_name,
                action_type: '입고',
                action_date: inDateISO,
                quantity: qty,
                previous_status: target.status,
                new_status: newStatus,
                notes: logNote
              }
            });

            if (qty === 0) showNotification(`입고 처리 완료 (0권) — ${target.course_name}`, 'info');
            else showNotification(`입고 완료! ${qty}권 추가 → ${displayName} 재고 ${newStock}권`, 'success');
            closeGroupStockInModal();
            await refreshCore();
          } catch (e) {
            console.error('Firebase 원자적 그룹 입고 오류:', e);
            showNotification(`입고 처리 실패: ${e.message || e}`, 'error');
          }
        };

        window.submitStockOutModal = async function submitStockOutModalAtomic() {
          if (!actorReady()) return;
          const courseId = document.getElementById('stock-out-modal-course-id').value;
          const input = document.getElementById('stock-out-modal-quantity');
          const outQty = parseInt(input.value);
          const notes = document.getElementById('stock-out-modal-notes').value || '출고 처리';
          if (isNaN(outQty) || outQty < 1) { showNotification('출고 수량을 입력해주세요.', 'error'); return; }
          const course = courses.find(c => c.id === courseId);
          if (!course) return;
          const groupKey = getGroupKey(course.course_name);
          const groupStock = getGroupTotalStock(groupKey);
          const otherRel = getGroupTotalReleased(groupKey, courseId);
          const groupAvail = groupStock - otherRel;
          if (outQty > groupAvail) {
            showNotification(`출고 수량(${outQty})이 그룹 잔여 재고(${groupAvail})를 초과합니다.`, 'error'); return;
          }
          const remain = groupAvail - outQty;

          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '출고완료', released_quantity: outQty, updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '출고',
                action_date: now,
                quantity: outQty,
                previous_status: course.status,
                new_status: '출고완료',
                notes: `출고 ${outQty}권 / 그룹 잔여 ${remain}권 / ${notes}`
              }
            });
            showNotification(`✅ 출고 완료! ${outQty}권 출고 / 잔여 ${remain}권`, 'success');
            closeStockOutModal();
            await refreshCore();
          } catch (e) {
            console.error('Firebase 원자적 출고 오류:', e);
            showNotification(`출고 처리 실패: ${e.message || e}`, 'error');
          }
        };

        window.approveStockIn = async function approveStockInAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course || !confirm('입고를 승인하시겠습니까?')) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '출고대기', updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '승인', action_date: now,
                previous_status: course.status, new_status: '출고대기',
                notes: '관리자 입고 승인'
              }
            });
            showNotification('입고가 승인되었습니다.', 'success');
            await refreshCore();
          } catch (e) {
            console.error('Firebase 원자적 입고 승인 오류:', e);
            showNotification(`승인 실패: ${e.message || e}`, 'error');
          }
        };

        window.approveStockOut = async function approveStockOutAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course || !confirm('출고를 승인하시겠습니까?')) return;
          try {
            const now = new Date().toISOString();
            await writeService.logOnly({
              courseId,
              actor: currentUser,
              log: {
                course_name: course.course_name,
                action_type: '승인', action_date: now,
                previous_status: course.status, new_status: course.status,
                notes: '관리자 출고 승인'
              }
            });
            showNotification('출고가 승인되었습니다.', 'success');
            if (typeof loadStockManagement === 'function') await loadStockManagement();
            await loadDashboardData();
          } catch (e) {
            console.error('Firebase 원자적 출고 승인 로그 오류:', e);
            showNotification(`승인 실패: ${e.message || e}`, 'error');
          }
        };

        window.confirmStockOut = async function confirmStockOutAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course) return;
          const relQty = course.released_quantity ?? course.student_count;
          const groupName = getGroupKey(course.course_name);
          const groupStock = getGroupTotalStock(groupName);
          const otherRel = getGroupTotalReleased(groupName, courseId);
          const remain = groupStock - otherRel - relQty;
          if (!confirm(`📋 담당자 출고 확인\n\n과정명: ${course.course_name}\n출고 수량: ${relQty}권\n그룹 잔여 수량: ${remain}권\n\n확인 후 세팅 관리로 넘어갑니다.`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '출고확인', confirmed_by: currentUser.name, confirmed_at: now, updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '확인', action_date: now,
                previous_status: course.status, new_status: '출고확인',
                notes: `담당자 출고확인 — 출고 ${relQty}권 / 잔여 ${remain}권`
              }
            });
            showNotification('출고 확인 완료! 세팅 관리로 넘어갑니다.', 'success');
            await refreshCore();
          } catch (e) {
            console.error('Firebase 원자적 출고 확인 오류:', e);
            showNotification(`출고 확인 실패: ${e.message || e}`, 'error');
          }
        };

        window.startSetup = async function startSetupAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course || !confirm(`${course.course_name} 세팅을 시작하시겠습니까?`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '세팅중', updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '세팅', action_date: now,
                previous_status: course.status, new_status: '세팅중', notes: '세팅 시작'
              }
            });
            showNotification('세팅이 시작되었습니다.', 'success');
            await loadCourses();
            await loadDashboardData();
          } catch (e) {
            console.error('Firebase 원자적 세팅 시작 오류:', e);
            showNotification(`세팅 시작 실패: ${e.message || e}`, 'error');
          }
        };

        window.completeSetup = async function completeSetupAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course || !confirm(`${course.course_name} 강의실 세팅이 완료되었습니까?\n담당자 최종 확인 후 세팅 완료 처리됩니다.`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '세팅완료대기', updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '완료', action_date: now,
                previous_status: course.status, new_status: '세팅완료대기',
                notes: '매니저 세팅 완료 — 담당자 최종확인 대기'
              }
            });
            showNotification('세팅 완료! 관리자 최종 확인을 기다립니다.', 'success');
            if (typeof notifyAction === 'function') notifyAction('세팅 완료', course.course_name, '관리자');
            await loadCourses();
            await loadDashboardData();
          } catch (e) {
            console.error('Firebase 원자적 세팅 완료 오류:', e);
            showNotification(`세팅 완료 처리 실패: ${e.message || e}`, 'error');
          }
        };

        window.finalConfirmSetup = async function finalConfirmSetupAtomic(courseId) {
          if (!actorReady()) return;
          const course = courses.find(c => c.id === courseId);
          if (!course || !confirm(`✅ 관리자 최종 확인\n\n${course.course_name}\n강의실 세팅 최종 완료를 확인하시겠습니까?`)) return;
          try {
            const now = new Date().toISOString();
            await writeService.updateCourseWithLog({
              courseId,
              expectedStatus: course.status,
              actor: currentUser,
              updates: { status: '세팅완료', setup_complete_date: now, updated_at: now },
              log: {
                course_name: course.course_name,
                action_type: '완료', action_date: now,
                previous_status: course.status, new_status: '세팅완료', notes: '관리자 최종확인 완료'
              }
            });
            showNotification('✅ 관리자 최종 확인 완료!', 'success');
            await loadCourses();
            await loadDashboardData();
          } catch (e) {
            console.error('Firebase 원자적 최종 확인 오류:', e);
            showNotification(`최종 확인 실패: ${e.message || e}`, 'error');
          }
        };

        window.__mgAtomicPatchReady = true;
        window.__mgAtomicPatchVersion = 'wave2';
        console.info('[Firebase Migration] Atomic patch wave2 enabled: stock-in/out, approvals, confirmation, setup workflow');
      } catch (e) {
        console.error('[Firebase Migration] Atomic patch init failed', e);
        window.__mgAtomicPatchReady = false;
      }
    }, 0);
  });
})();
