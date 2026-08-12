// Simple mobile inventory service.
// Guarantees: block negative stock on new outbound transactions, atomic stock mutation + log,
// reversible inventory-list hiding, safe display-name management, and simple item creation.
(function () {
  'use strict';

  window.simpleInventoryServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    const timestampFields = new Set([
      'actual_release_date','updated_at','action_date','created_at','inventory_hidden_at'
    ]);
    const canManage = actor => !!actor && (actor.canManage === true || actor.canHide === true || actor.name === '주나연');

    function cv(field, value) {
      if (value === null || value === undefined) return value;
      if (timestampFields.has(field) && typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      return value;
    }
    function object(input) {
      const out = {};
      for (const [k,v] of Object.entries(input || {})) if (v !== undefined) out[k] = cv(k,v);
      return out;
    }
    function uid(prefix) {
      return (globalThis.crypto && crypto.randomUUID)
        ? `${prefix}_${crypto.randomUUID()}`
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
    function logData({courseId, courseName, type, quantity, actor, notes, previousStatus, newStatus}) {
      const now = new Date().toISOString();
      return {
        id: uid('log'), course_id: String(courseId), course_name: courseName || '',
        action_type: type, action_date: now, user_name: actor?.name || '', user_role: actor?.role || '',
        quantity: quantity ?? null, previous_status: previousStatus ?? null, new_status: newStatus ?? null,
        notes: notes || '', created_at: now
      };
    }
    function finiteNonNegative(value) {
      const n = Number(value || 0);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    async function createInventoryItem({name, itemType, initialStock, actor, memo}) {
      const displayName = cleanName(name);
      const qty = Number(initialStock || 0);
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!canManage(actor)) throw new Error('새 교재/과정 등록은 주나연 담당자만 할 수 있습니다.');
      if (!displayName) throw new Error('교재명 또는 과정명을 입력해주세요.');
      if (!Number.isInteger(qty) || qty < 0) throw new Error('첫 입고 수량은 0권 이상 정수로 입력해주세요.');

      const courseId = uid('inventory');
      const now = new Date().toISOString();
      const status = qty > 0 ? '입고완료' : '입고대기';
      const course = {
        id: courseId,
        course_name: displayName,
        inventory_display_name: displayName,
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
      batch.set(fs.doc(db, 'courses', courseId), object(course));
      const createLog = logData({
        courseId, courseName: displayName, type: '신규등록', quantity: null, actor,
        previousStatus: null, newStatus: status,
        notes: `${course.inventory_item_type} 신규 등록${memo ? ` · ${cleanName(memo)}` : ''}`
      });
      batch.set(fs.doc(db, 'work_logs', createLog.id), object(createLog));
      let stockLogId = null;
      if (qty > 0) {
        const stockLog = logData({
          courseId, courseName: displayName, type: '입고', quantity: qty, actor,
          previousStatus: '입고대기', newStatus: '입고완료',
          notes: `신규 등록과 함께 첫 입고 ${qty}권${memo ? ` · ${cleanName(memo)}` : ''}`
        });
        stockLogId = stockLog.id;
        batch.set(fs.doc(db, 'work_logs', stockLog.id), object(stockLog));
      }
      await batch.commit();
      return {courseId, createLogId: createLog.id, stockLogId};
    }

    async function renameInventoryGroup({groupCourseIds, oldName, newName, actor}) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      const before = cleanName(oldName);
      const after = cleanName(newName);
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!canManage(actor)) throw new Error('이름 변경은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('이름을 변경할 대상이 없습니다.');
      if (ids.length > 450) throw new Error('연결된 과정이 너무 많아 한 번에 변경할 수 없습니다.');
      if (!after) throw new Error('새 이름을 입력해주세요.');
      if (before === after) throw new Error('현재 이름과 같습니다.');

      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db, 'courses', id), object({
          inventory_display_name: after, updated_by: actor.name, updated_at: now
        }));
      }
      const log = logData({
        courseId: `group:${ids[0]}`, courseName: after, type: '이름변경', quantity: null, actor,
        notes: `교재/과정 표시명 변경: "${before}" → "${after}"`
      });
      batch.set(fs.doc(db, 'work_logs', log.id), object(log));
      await batch.commit();
      return {newName: after, logId: log.id};
    }

    async function stockInGroup({targetCourseId, quantity, actor, memo}) {
      const qty = Number(quantity);
      if (!targetCourseId) throw new Error('입고 대상 과정이 없습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('입고 수량은 1권 이상 정수로 입력해주세요.');
      const ref = fs.doc(db, 'courses', String(targetCourseId));
      let committedStock = 0, committedStatus = null, logId = null;
      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('입고 대상 과정이 존재하지 않습니다.');
        const current = snap.data();
        committedStock = finiteNonNegative(current.stock_quantity) + qty;
        committedStatus = current.status === '입고대기' ? '입고완료' : current.status;
        const now = new Date().toISOString();
        const displayName = cleanName(current.inventory_display_name) || cleanName(current.course_name);
        const log = logData({
          courseId: targetCourseId, courseName: displayName, type: '입고', quantity: qty, actor,
          previousStatus: current.status, newStatus: committedStatus,
          notes: memo || `블록 입고 ${qty}권`
        });
        logId = log.id;
        tx.update(ref, object({stock_quantity: committedStock, status: committedStatus, updated_by: actor.name, updated_at: now}));
        tx.set(fs.doc(db,'work_logs',log.id), object(log));
      });
      return {stockQuantity: committedStock, status: committedStatus, logId};
    }

    async function stockOutGroup({targetCourseId, groupCourseIds, quantity, actor, memo}) {
      const qty = Number(quantity);
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!targetCourseId || !ids.includes(String(targetCourseId))) throw new Error('출고 대상 과정 정보가 올바르지 않습니다.');
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('출고 수량은 1권 이상 정수로 입력해주세요.');
      if (ids.length > 100) throw new Error('한 교재에 연결된 과정이 너무 많습니다. 관리자 점검이 필요합니다.');
      const refs = ids.map(id => fs.doc(db,'courses',id));
      let availableBefore = 0, availableAfter = 0, releasedAfter = 0, logId = null;
      await fs.runTransaction(db, async tx => {
        const snaps = [];
        for (const ref of refs) snaps.push(await tx.get(ref));
        const rows = snaps.filter(s => s.exists()).map(s => ({id:s.id, ref:s.ref, data:s.data()}));
        const target = rows.find(r => r.id === String(targetCourseId));
        if (!target) throw new Error('출고 대상 과정이 존재하지 않습니다.');
        const totalStock = rows.reduce((s,r) => s + finiteNonNegative(r.data.stock_quantity), 0);
        const totalReleased = rows.reduce((s,r) => s + finiteNonNegative(r.data.released_quantity), 0);
        availableBefore = totalStock - totalReleased;
        if (availableBefore < 0) {
          const err = new Error(`기존 재고 기록이 맞지 않아 출고할 수 없습니다. 입고 ${totalStock}권 / 출고 ${totalReleased}권을 먼저 확인해주세요.`);
          err.code = 'mg/stock-integrity-error'; throw err;
        }
        if (qty > availableBefore) {
          const err = new Error(`현재 잔고 ${availableBefore}권보다 많이 출고할 수 없습니다.`);
          err.code = 'mg/insufficient-group-stock'; throw err;
        }
        releasedAfter = finiteNonNegative(target.data.released_quantity) + qty;
        availableAfter = availableBefore - qty;
        if (availableAfter < 0) {
          const err = new Error('출고 후 잔고가 음수가 되는 작업은 저장할 수 없습니다.');
          err.code = 'mg/negative-stock-blocked'; throw err;
        }
        const now = new Date().toISOString();
        const displayName = cleanName(target.data.inventory_display_name) || cleanName(target.data.course_name);
        const log = logData({
          courseId: targetCourseId, courseName: displayName, type: '출고', quantity: qty, actor,
          previousStatus: target.data.status, newStatus: '출고완료',
          notes: memo || `출고 ${qty}권 · 출고 후 잔고 ${availableAfter}권`
        });
        logId = log.id;
        tx.update(target.ref, object({released_quantity: releasedAfter, status:'출고완료', actual_release_date:now, updated_by:actor.name, updated_at:now}));
        tx.set(fs.doc(db,'work_logs',log.id), object(log));
      });
      return {availableBefore, availableAfter, releasedAfter, logId};
    }

    async function setGroupHidden({groupCourseIds, groupName, hidden, actor}) {
      const ids = [...new Set((groupCourseIds || []).map(String).filter(Boolean))];
      if (!actor) throw new Error('작업자가 선택되지 않았습니다.');
      if (!canManage(actor)) throw new Error('과정 숨김/복원은 주나연 담당자만 할 수 있습니다.');
      if (!ids.length) throw new Error('숨김 처리할 과정이 없습니다.');
      if (ids.length > 450) throw new Error('숨김 처리 대상이 너무 많습니다.');
      const batch = fs.writeBatch(db);
      const now = new Date().toISOString();
      for (const id of ids) {
        batch.update(fs.doc(db,'courses',id), object({
          inventory_hidden:!!hidden, inventory_hidden_at:hidden?now:null, inventory_hidden_by:hidden?actor.name:null,
          updated_by:actor.name, updated_at:now
        }));
      }
      const log = logData({
        courseId:`group:${ids[0]}`, courseName:groupName, type:hidden?'숨김':'복원', quantity:null, actor,
        notes:hidden?'운영 종료 · 재고 화면에서 숨김':'숨긴 항목 · 재고 화면에 다시 표시'
      });
      batch.set(fs.doc(db,'work_logs',log.id), object(log));
      await batch.commit();
      return {hidden:!!hidden, logId:log.id};
    }

    return {createInventoryItem, renameInventoryGroup, stockInGroup, stockOutGroup, setGroupHidden};
  })();

  // UI extension: turn the inbound screen into the simple inventory management hub.
  window.addEventListener('load', function () {
    if (typeof state === 'undefined' || typeof renderIn !== 'function') return;

    const baseGroupName = window.groupName || function(v){return String(v||'').trim();};
    window.inventoryDisplayName = function(course) {
      const explicit = String(course?.inventory_display_name || '').trim();
      return explicit || baseGroupName(course?.course_name || '');
    };
    window.inventoryKey = function(name) {
      return String(name || '').trim().replace(/\s+/g,'').toLowerCase();
    };

    window.rebuildGroups = function () {
      const m = new Map();
      for (const c of state.courses) {
        const displayName = window.inventoryDisplayName(c);
        const k = window.inventoryKey(displayName);
        if (!m.has(k)) m.set(k,{key:k,name:displayName,courses:[],stock:0,released:0,hiddenCount:0,itemTypes:new Set()});
        const g=m.get(k);
        g.courses.push(c);
        g.stock += Math.max(0,num(c.stock_quantity));
        g.released += Math.max(0,num(c.released_quantity));
        if(c.inventory_hidden===true) g.hiddenCount++;
        if(c.inventory_item_type) g.itemTypes.add(c.inventory_item_type);
      }
      for(const g of m.values()){
        g.courses.sort((a,b)=>(date(a.start_date)||0)-(date(b.start_date)||0));
        g.hidden=g.courses.length>0&&g.hiddenCount===g.courses.length;
        g.balance=g.stock-g.released;
        g.itemType=[...g.itemTypes][0]||'교재';
      }
      state.groups=[...m.values()].sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    };

    window.weekCourses = function () {
      const {s,e}=weekRange();
      return state.courses.filter(c=>{
        if(c.inventory_only===true) return false;
        const g=courseGroup(c),d=date(c.start_date);
        return g&&!g.hidden&&d&&d>=s&&d<e;
      }).sort((a,b)=>(date(a.start_date)||0)-(date(b.start_date)||0));
    };

    const viewIn = document.getElementById('view-in');
    if(viewIn){
      const pageHead=viewIn.querySelector('.page-head');
      if(pageHead && !document.getElementById('newItemBtn')){
        const controls=document.createElement('div');
        controls.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end';
        controls.innerHTML='<button id="newItemBtn" class="btn blue small" style="display:none">＋ 새 교재/과정</button>';
        const hidden=document.getElementById('hiddenBtn');
        if(hidden) controls.appendChild(hidden);
        pageHead.appendChild(controls);
      }
      const info=viewIn.querySelector('.info-box');
      if(info) info.innerHTML='<b>입고 화면에서 모두 관리합니다.</b><br><span style="font-size:13px">새 교재/과정 등록 · 이름 변경 · 입고 · 운영 종료 숨김까지 한 곳에서 처리합니다. 모든 변경은 기록됩니다.</span>';
    }

    const extraStyle=document.createElement('style');
    extraStyle.textContent='.manage-row{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap}.manage-row .btn{flex:1;min-width:92px}.type-note{font-size:11px;color:#64748b;background:#f1f5f9;border-radius:999px;padding:4px 8px;font-weight:850}.chip.active{background:#2563eb;color:#fff;border-color:#2563eb}.new-action{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:12px}.new-action .btn{min-height:54px;font-size:16px}';
    document.head.appendChild(extraStyle);

    window.renderIn = function () {
      const q=$('#inSearch').value.trim().toLowerCase();
      const list=activeGroups().filter(g=>!q||g.name.toLowerCase().includes(q));
      const canAdmin=state.actor?.name==='주나연';
      const newBtn=document.getElementById('newItemBtn');
      if(newBtn) newBtn.style.display=canAdmin?'inline-flex':'none';
      $('#inList').innerHTML=list.map(g=>{
        const l=stockLevel(g);
        const type=g.itemType&&g.itemType!=='교재'?`<span class="type-note">${esc(g.itemType)}</span>`:'';
        const adminActions=canAdmin?`<div class="manage-row"><button class="btn light small" onclick="openRenameItem('${esc(g.key)}')">이름 변경</button><button class="btn light small" onclick="confirmHide('${esc(g.key)}')">운영 종료 · 숨기기</button></div>`:'';
        return `<div class="inventory-card ${l.cls}"><div class="row"><div style="min-width:0"><div class="name">${esc(g.name)}</div><div class="meta">${type} 현재 잔고 ${g.balance}권</div><div class="stock-status-row"><span class="badge ${l.cls}">${l.label}</span></div></div><button class="btn green small" onclick="openIn('${esc(g.key)}')">＋ 입고</button></div>${adminActions}</div>`;
      }).join('')||'<div class="empty">검색 결과가 없습니다.<br>주나연 담당자는 위의 ‘새 교재/과정’에서 바로 등록할 수 있습니다.</div>';
    };

    window.openCreateItem = function () {
      const actor=actorRequired();
      if(!actor||actor.name!=='주나연'){notice('새 교재/과정 등록은 주나연 담당자만 가능합니다.');return;}
      window.__newItemType='교재';
      openSheet(`<div class="sheet-title">새 교재/과정 등록</div><div class="sheet-sub">교재, 부교재, 추가교재 등 이름을 자유롭게 등록합니다. 일정이 없는 재고 전용 항목은 ‘이번 주’ 화면에 나타나지 않습니다.</div><div class="field"><label>이름</label><input id="newItemName" type="text" placeholder="예: 여신실무 사례집"></div><div class="field"><label>구분</label><div class="chips" id="newTypeChips"><button class="chip active" data-type="교재">교재</button><button class="chip" data-type="부교재">부교재</button><button class="chip" data-type="추가교재">추가교재</button><button class="chip" data-type="기타">기타</button></div></div><div class="field"><label>첫 입고 수량 <span style="font-weight:500;color:#94a3b8">(없으면 0)</span></label><input id="newItemQty" class="big-number" type="number" inputmode="numeric" min="0" value="0"></div><div class="field"><label>메모 (선택)</label><textarea id="newItemMemo" placeholder="예: 신규 제작"></textarea></div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="newItemSubmit" class="btn blue" onclick="submitCreateItem()">등록</button></div>`);
      document.querySelectorAll('#newTypeChips .chip').forEach(b=>b.onclick=()=>{document.querySelectorAll('#newTypeChips .chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');window.__newItemType=b.dataset.type;});
      setTimeout(()=>document.getElementById('newItemName')?.focus(),100);
    };

    window.submitCreateItem = async function () {
      const actor=actorRequired();
      if(!actor||actor.name!=='주나연') return;
      const name=document.getElementById('newItemName')?.value.trim();
      const qty=parseInt(document.getElementById('newItemQty')?.value||'0',10);
      const memo=document.getElementById('newItemMemo')?.value.trim()||'';
      if(!name){notice('이름을 입력해주세요.');return;}
      const duplicate=state.groups.some(g=>g.name.trim().toLowerCase()===name.toLowerCase());
      if(duplicate){notice('같은 이름이 이미 있습니다. 기존 항목에서 입고해주세요.');return;}
      const btn=document.getElementById('newItemSubmit'); if(btn)btn.disabled=true;
      try{
        await state.inventory.createInventoryItem({name,itemType:window.__newItemType||'교재',initialStock:Number.isInteger(qty)?qty:0,actor,memo});
        closeSheet();notice(`${name} 등록 완료${qty>0?` · 첫 입고 ${qty}권`:''}`);await loadAll();
      }catch(e){console.error(e);notice('등록 실패 · '+(e.message||e));}
      finally{if(btn)btn.disabled=false;}
    };

    window.openRenameItem = function (key) {
      const actor=actorRequired(),g=state.groups.find(x=>x.key===key);
      if(!actor||actor.name!=='주나연'){notice('이름 변경은 주나연 담당자만 가능합니다.');return;}
      if(!g)return;
      openSheet(`<div class="sheet-title">이름 변경</div><div class="sheet-sub">입고·재고 화면에서 보이는 이름을 바꿉니다. 기존 교육과정 일정명과 과거 기록은 보존됩니다.</div><div class="field"><label>현재 이름</label><div class="card" style="box-shadow:none;margin:0">${esc(g.name)}</div></div><div class="field"><label>새 이름</label><input id="renameItemName" type="text" value="${esc(g.name)}"></div><div class="sheet-actions"><button class="btn light" onclick="closeSheet()">취소</button><button id="renameItemSubmit" class="btn blue" onclick="submitRenameItem('${esc(key)}')">이름 변경</button></div>`);
      setTimeout(()=>{const el=document.getElementById('renameItemName');if(el){el.focus();el.select();}},100);
    };

    window.submitRenameItem = async function (key) {
      const actor=actorRequired(),g=state.groups.find(x=>x.key===key);
      if(!actor||actor.name!=='주나연'||!g)return;
      const name=document.getElementById('renameItemName')?.value.trim();
      if(!name){notice('새 이름을 입력해주세요.');return;}
      const duplicate=state.groups.some(x=>x.key!==g.key&&x.name.trim().toLowerCase()===name.toLowerCase());
      if(duplicate){notice('같은 이름이 이미 있습니다. 다른 이름을 사용해주세요.');return;}
      const btn=document.getElementById('renameItemSubmit');if(btn)btn.disabled=true;
      try{
        await state.inventory.renameInventoryGroup({groupCourseIds:g.courses.map(c=>c.id),oldName:g.name,newName:name,actor});
        closeSheet();notice(`이름 변경 완료 · ${name}`);await loadAll();
      }catch(e){console.error(e);notice('이름 변경 실패 · '+(e.message||e));}
      finally{if(btn)btn.disabled=false;}
    };

    const newBtn=document.getElementById('newItemBtn');
    if(newBtn)newBtn.onclick=window.openCreateItem;

    // Add management permission hint to operator objects used by the existing page.
    if(Array.isArray(OPERATORS)){
      OPERATORS.forEach(op=>{op.canManage=op.name==='주나연';});
    }
    if(state.actor){state.actor.canManage=state.actor.name==='주나연';}

    rebuildGroups();
    renderAll();
  });
})();
