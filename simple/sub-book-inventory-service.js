// Atomic inventory service for legacy sub_books / sub_book_logs.
// Keeps historical stock/released fields intact while new physical-stock corrections
// are recorded explicitly in inventory_adjustment.
(function () {
  'use strict';

  window.subBookInventoryServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    function n(value) {
      const x = Number(value || 0);
      return Number.isFinite(x) ? x : 0;
    }

    function clean(value) {
      return String(value || '').trim().replace(/\s+/g, ' ');
    }

    function makeId(prefix) {
      return globalThis.crypto?.randomUUID
        ? `${prefix}_${crypto.randomUUID()}`
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function displayName(book) {
      return clean(book.inventory_display_name) || clean(book.book_name) || '부교재';
    }

    function balance(book) {
      return n(book.stock_quantity) - n(book.released_quantity) + n(book.inventory_adjustment);
    }

    function requireActor(actor) {
      if (!actor?.name) throw new Error('작업자가 선택되지 않았습니다.');
    }

    function requireManager(actor, action) {
      requireActor(actor);
      if (!actor.canManage) throw new Error(`${action}은 주나연 담당자만 할 수 있습니다.`);
    }

    function makeLog(book, type, quantity, actor, notes, before, after) {
      const now = new Date();
      const id = makeId('sublog');
      return {
        id,
        sub_book_id: String(book.id),
        book_id: String(book.id),
        book_name: displayName(book),
        course_name: displayName(book),
        course_group_key: book.course_group_key || null,
        course_group_name: book.course_group_name || null,
        action_type: type,
        action_date: fs.Timestamp.fromDate(now),
        created_at: fs.Timestamp.fromDate(now),
        user_name: actor.name,
        user: actor.name,
        user_role: actor.role || '',
        quantity: quantity ?? null,
        before_balance: before,
        after_balance: after,
        notes: notes || ''
      };
    }

    async function withBook(subBookId, worker) {
      if (!subBookId) throw new Error('부교재 ID가 없습니다.');
      const ref = fs.doc(db, 'sub_books', String(subBookId));
      return fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('부교재를 찾을 수 없습니다.');
        const book = { id: snap.id, ...snap.data() };
        return worker({ tx, ref, book });
      });
    }

    async function stockIn({ subBookId, quantity, actor, memo }) {
      requireActor(actor);
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('입고 수량은 1권 이상 정수로 입력해주세요.');

      return withBook(subBookId, async ({ tx, ref, book }) => {
        const before = balance(book);
        const after = before + qty;
        const log = makeLog(
          book,
          '입고',
          qty,
          actor,
          clean(memo) || `부교재 입고 ${qty}권 · ${before}권 → ${after}권`,
          before,
          after
        );
        tx.update(ref, {
          stock_quantity: n(book.stock_quantity) + qty,
          updated_at: fs.Timestamp.now(),
          updated_by: actor.name
        });
        tx.set(fs.doc(db, 'sub_book_logs', log.id), log);
        return { before, after, logId: log.id, name: displayName(book) };
      });
    }

    async function emergencyOut({ subBookId, quantity, actor, memo }) {
      requireManager(actor, '비상출고');
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('비상출고 수량은 1권 이상 정수로 입력해주세요.');

      return withBook(subBookId, async ({ tx, ref, book }) => {
        const before = balance(book);
        if (before < 0) throw new Error('현재 잔고가 음수입니다. 실물재고 맞춤을 먼저 해주세요.');
        if (qty > before) throw new Error(`현재 잔고 ${before}권보다 많이 비상출고할 수 없습니다.`);
        const after = before - qty;
        const note = clean(memo);
        const log = makeLog(
          book,
          '비상출고',
          qty,
          actor,
          `[비상출고] ${note || '입고담당자 재량 출고'} · ${before}권 → ${after}권`,
          before,
          after
        );
        tx.update(ref, {
          released_quantity: n(book.released_quantity) + qty,
          updated_at: fs.Timestamp.now(),
          updated_by: actor.name
        });
        tx.set(fs.doc(db, 'sub_book_logs', log.id), log);
        return { before, after, logId: log.id, name: displayName(book) };
      });
    }

    async function reconcile({ subBookId, actualStock, actor, memo }) {
      requireManager(actor, '실물재고 맞춤');
      const actual = Number(actualStock);
      if (!Number.isInteger(actual) || actual < 0) throw new Error('실제 보유 수량은 0권 이상 정수로 입력해주세요.');

      return withBook(subBookId, async ({ tx, ref, book }) => {
        const before = balance(book);
        const delta = actual - before;
        if (delta === 0) throw new Error('앱 잔고와 실물 수량이 같습니다. 조정할 내용이 없습니다.');
        const note = clean(memo);
        const log = makeLog(
          book,
          '재고조정',
          Math.abs(delta),
          actor,
          `실물재고 맞춤 ${before}권 → ${actual}권 · 조정 ${delta > 0 ? '+' : ''}${delta}권${note ? ` · ${note}` : ''}`,
          before,
          actual
        );
        tx.update(ref, {
          inventory_adjustment: n(book.inventory_adjustment) + delta,
          updated_at: fs.Timestamp.now(),
          updated_by: actor.name
        });
        tx.set(fs.doc(db, 'sub_book_logs', log.id), log);
        return { before, after: actual, adjustment: delta, logId: log.id, name: displayName(book) };
      });
    }

    async function rename({ subBookId, newName, actor }) {
      requireManager(actor, '이름 변경');
      const afterName = clean(newName);
      if (!afterName) throw new Error('새 이름을 입력해주세요.');

      return withBook(subBookId, async ({ tx, ref, book }) => {
        const beforeName = displayName(book);
        if (beforeName === afterName) throw new Error('현재 이름과 같습니다.');
        const currentBalance = balance(book);
        const log = makeLog(
          { ...book, inventory_display_name: afterName },
          '이름변경',
          null,
          actor,
          `부교재 표시명 변경: "${beforeName}" → "${afterName}"`,
          currentBalance,
          currentBalance
        );
        tx.update(ref, {
          inventory_display_name: afterName,
          updated_at: fs.Timestamp.now(),
          updated_by: actor.name
        });
        tx.set(fs.doc(db, 'sub_book_logs', log.id), log);
        return { beforeName, afterName, balance: currentBalance, logId: log.id };
      });
    }

    async function setHidden({ subBookId, hidden, actor }) {
      requireManager(actor, hidden ? '숨김' : '복원');

      return withBook(subBookId, async ({ tx, ref, book }) => {
        const currentBalance = balance(book);
        const log = makeLog(
          book,
          hidden ? '숨김' : '복원',
          null,
          actor,
          hidden ? '운영 종료 · 부교재 숨김' : '숨긴 부교재 다시 표시',
          currentBalance,
          currentBalance
        );
        tx.update(ref, {
          inventory_hidden: !!hidden,
          inventory_hidden_at: hidden ? fs.Timestamp.now() : null,
          inventory_hidden_by: hidden ? actor.name : null,
          updated_at: fs.Timestamp.now(),
          updated_by: actor.name
        });
        tx.set(fs.doc(db, 'sub_book_logs', log.id), log);
        return { hidden: !!hidden, balance: currentBalance, logId: log.id, name: displayName(book) };
      });
    }

    const service = { balance, stockIn, emergencyOut, reconcile, rename, setHidden };
    window.subBookInventoryService = service;
    return service;
  })();
})();
