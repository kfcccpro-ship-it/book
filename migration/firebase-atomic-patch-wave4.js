// Wave 4 atomic write overrides.
// Scope: sub-book CRUD + stock/release log transaction, quick release,
// guarded import, and hard-disable destructive full reset in Firebase preview.
(function () {
  'use strict';

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
      try {
        const [writeService, subBookService] = await Promise.all([
          window.firebaseWriteServiceReady,
          window.firebaseSubBookServiceReady
        ]);

        function actorReady() {
          if (typeof requireUser === 'function' && !requireUser()) return false;
          if (!currentUser) {
            showNotification('작업자를 먼저 선택해주세요.', 'error');
            return false;
          }
          return true;
        }

        async function refreshSubBooks(groupKey) {
          await loadSubBooks();
          if (groupKey && typeof renderSubBookList === 'function') renderSubBookList(groupKey);
          if (typeof renderSubBookInventory === 'function') renderSubBookInventory();
          if (typeof updateStockInventoryTable === 'function') updateStockInventoryTable();
          if (typeof renderAdminCoursesList === 'function') renderAdminCoursesList();
        }

        window.addSubBook = async function addSubBookAtomic() {
          if (!actorReady()) return;
          const groupKey = document.getElementById('sub-book-group-key').value;
          const groupName = document.getElementById('sub-book-group-name').value;
          const name = document.getElementById('sub-book-new-name').value.trim();
          if (!name) { showNotification('부교재 이름을 입력해주세요.', 'error'); return; }
          try {
            await subBookService.insertSubBook({
              subBook: { course_group_key:groupKey, course_group_name:groupName, book_name:name, stock_quantity:0, released_quantity:0 },
              actor: currentUser
            });
            showNotification(`"${name}" 부교재가 등록되었습니다.`, 'success');
            document.getElementById('sub-book-new-name').value = '';
            await refreshSubBooks(groupKey);
          } catch(e) { console.error(e); showNotification(`부교재 추가 실패: ${e.message || e}`, 'error'); }
        };

        window.deleteSubBook = async function deleteSubBookAtomic(id, name) {
          if (!actorReady()) return;
          if (!confirm(`"${name}" 부교재를 삭제하시겠습니까?\n모든 입출고 기록도 함께 삭제됩니다.`)) return;
          try {
            const result = await subBookService.deleteSubBookWithLogs({ subBookId:id });
            showNotification(`"${name}" 삭제 완료 · 로그 ${result.deletedLogs}건 정리`, 'success');
            await refreshSubBooks(document.getElementById('sub-book-group-key')?.value);
          } catch(e) { console.error(e); showNotification(`부교재 삭제 실패: ${e.message || e}`, 'error'); }
        };

        window.submitSubBookAction = async function submitSubBookActionAtomic() {
          if (!actorReady()) return;
          const id = document.getElementById('sub-book-action-id').value;
          const actionType = document.getElementById('sub-book-action-type').value;
          const qty = parseInt(document.getElementById('sub-book-action-qty').value);
          const date = document.getElementById('sub-book-action-date').value;
          const notes = document.getElementById('sub-book-action-notes').value.trim();
          if (isNaN(qty) || qty < 1) { showNotification('수량을 입력해주세요.', 'error'); return; }
          if (!date) { showNotification('날짜를 입력해주세요.', 'error'); return; }
          const book = subBooks.find(b => b.id === id);
          if (!book) { showNotification('부교재 정보를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.', 'error'); return; }
          const stock = Number(book.stock_quantity || 0), released = Number(book.released_quantity || 0), rem = stock - released;
          if (actionType === '출고' && qty > rem) { showNotification(`잔여 재고(${rem}권)를 초과할 수 없습니다.`, 'error'); return; }
          if (!confirm(`📗 부교재 ${actionType} 확인\n\n${book.book_name}\n날짜: ${date}\n수량: ${qty}권\n${notes ? '메모: '+notes : ''}\n\n진행하시겠습니까?`)) return;
          try {
            await subBookService.updateSubBookWithLog({
              subBookId:id, expectedStock:stock, expectedReleased:released,
              updates:{ stock_quantity:actionType==='입고'?stock+qty:stock, released_quantity:actionType==='출고'?released+qty:released },
              log:{ action_type:actionType, quantity:qty, action_date:new Date(date+'T09:00:00').toISOString(), notes:notes || `${actionType} ${qty}권` },
              actor:currentUser
            });
            showNotification(`부교재 ${actionType} 완료! ${book.book_name} ${qty}권`, 'success');
            closeSubBookActionModal(); await refreshSubBooks(document.getElementById('sub-book-group-key')?.value || book.course_group_key);
          } catch(e) { console.error(e); showNotification(`부교재 ${actionType} 실패: ${e.message || e}`, 'error'); }
        };

        window.submitQuickRelease = async function submitQuickReleaseAtomic() {
          if (!actorReady()) return;
          const groupKey = document.getElementById('group-manage-group-name').value;
          const qty = parseInt(document.getElementById('quick-release-quantity').value);
          const notes = document.getElementById('quick-release-notes').value.trim();
          const displayName = (() => { const c=courses.find(x=>getGroupKey(x.course_name)===groupKey); return c?getGroupName(c.course_name):groupKey; })();
          if (isNaN(qty)||qty<1) { showNotification('출고 수량을 입력해주세요.','error'); return; }
          if (!notes) { showNotification('출고 사유를 입력해주세요.','error'); return; }
          const totalStock=getGroupTotalStock(groupKey), totalReleased=getGroupTotalReleased(groupKey), remaining=totalStock-totalReleased;
          if (qty>remaining) { showNotification(`잔여 재고(${remaining}권)를 초과할 수 없습니다.`,'error'); return; }
          const target=courses.filter(c=>getGroupKey(c.course_name)===groupKey&&['입고완료','출고완료'].includes(c.status)).sort((a,b)=>new Date(a.start_date)-new Date(b.start_date))[0];
          if (!target) { showNotification('입고완료 또는 출고완료 상태의 과정이 없습니다.','error'); return; }
          if (!confirm(`📤 급 출고 확인\n\n${displayName}\n출고 수량: ${qty}권\n사유: ${notes}\n\n진행하시겠습니까?`)) return;
          try {
            const now=new Date().toISOString(), newReleased=Number(target.released_quantity||0)+qty;
            await writeService.updateCourseWithLog({ courseId:target.id, expectedStatus:target.status, actor:currentUser,
              updates:{status:'출고완료',released_quantity:newReleased,actual_release_date:now,updated_at:now},
              log:{course_name:target.course_name,action_type:'출고',action_date:now,quantity:qty,previous_status:target.status,new_status:'출고완료',notes:`급 출고 ${qty}권 / 사유: ${notes} / 잔여 ${remaining-qty}권`} });
            showNotification(`급 출고 완료! ${qty}권 → ${displayName} 잔여 ${remaining-qty}권`,'success');
            document.getElementById('quick-release-quantity').value=''; document.getElementById('quick-release-notes').value=''; document.getElementById('quick-release-remain').textContent='';
            await loadCourses(); await loadDashboardData(); if (typeof renderStockLists==='function') renderStockLists();
          } catch(e) { console.error(e); showNotification(`급 출고 실패: ${e.message||e}`,'error'); }
        };

        window.processImport = async function processImportGuarded() {
          if (!actorReady()) return;
          const raw=document.getElementById('import-data').value.trim();
          if (!raw) { showNotification('데이터를 입력해주세요.','error'); return; }
          const lines=raw.split(/\r?\n/).filter(line=>line.trim());
          if (lines.length<2) { showNotification('최소 2줄(헤더 + 데이터) 이상 필요합니다.','error'); return; }
          const rows=[];
          for(let i=1;i<lines.length;i++){
            const f=lines[i].split(/[\t,]/).map(x=>x.trim());
            if(f.length<4){showNotification(`${i+1}행 형식이 올바르지 않습니다. 가져오기를 중단했습니다.`,'error');return;}
            const [courseName,startDate,endDate,studentCount,releaseDate,classroom]=f; const start=new Date(startDate);
            if(!courseName||Number.isNaN(start.getTime())||!(parseInt(studentCount)>0)){showNotification(`${i+1}행 과정명/시작일/인원을 확인해주세요. 가져오기를 중단했습니다.`,'error');return;}
            const autoRelease=releaseDate||(()=>{const d=new Date(start);d.setDate(d.getDate()-5);return d.toISOString().split('T')[0];})();
            rows.push({courseName,startDate,endDate,studentCount:parseInt(studentCount),releaseDate:autoRelease,classroom});
          }
          if(!confirm(`${rows.length}개 과정을 Firebase에 추가합니다.\n각 과정은 과정+추가로그가 함께 저장됩니다. 진행하시겠습니까?`))return;
          try{
            for(const row of rows){const now=new Date().toISOString();const newId='import_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);const course={id:newId,course_name:row.courseName,start_date:new Date(row.startDate).toISOString(),end_date:row.endDate?new Date(row.endDate).toISOString():null,student_count:row.studentCount,stock_quantity:0,released_quantity:0,scheduled_release_date:new Date(row.releaseDate).toISOString(),classroom:row.classroom||'',status:'입고대기',created_by:currentUser.name,updated_by:currentUser.name,created_at:now,updated_at:now};await writeService.insertCourseWithLog({course,actor:currentUser,log:{course_name:row.courseName,action_type:'추가',action_date:now,previous_status:null,new_status:'입고대기',notes:`가져오기 과정 추가: ${row.courseName}`}});}
            showNotification(`가져오기 완료: ${rows.length}건`,'success');closeImportModal();await loadCourses();await loadDashboardData();
          }catch(e){console.error(e);showNotification(`가져오기 중단: ${e.message||e}. 이미 완료된 행은 작업로그에서 확인할 수 있습니다.`,'error');}
        };

        window.openResetModal=function(){showNotification('Firebase 운영 버전에서는 전체 데이터 초기화 기능을 사용하지 않습니다. 개별 수정/삭제 기능을 이용해주세요.','warning');};
        window.confirmReset=function(){showNotification('전체 데이터 초기화는 안전을 위해 비활성화되어 있습니다.','warning');};
        window.resetAllData=async function(){throw new Error('Firebase 운영 버전에서는 전체 데이터 초기화가 비활성화되어 있습니다.');};

        window.__mgAtomicPatchWave4Ready=true; window.__mgAtomicPatchVersion='wave4';
        console.info('[Firebase Migration] Atomic patch wave4 enabled: sub-books, quick release, guarded import; full reset disabled');
      } catch(e) { console.error('[Firebase Migration] Atomic patch wave4 init failed',e); window.__mgAtomicPatchWave4Ready=false; }
    },0);
  });
})();
