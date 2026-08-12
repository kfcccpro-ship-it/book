// MG textbook inventory - Firebase compatibility adapter
// Migration branch only. Preserves the legacy sb.from(...) call surface so
// database migration can be validated before UI/data-model redesign.
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: 'AIzaSyBN-tcOvDxFoJ7qNdcwWmXW18hpzQKsTJM',
    authDomain: 'new-book-e6ec7.firebaseapp.com',
    projectId: 'new-book-e6ec7',
    storageBucket: 'new-book-e6ec7.firebasestorage.app',
    messagingSenderId: '640496706167',
    appId: '1:640496706167:web:96bb5072d05d3b81029c72'
  };

  const TIMESTAMP_FIELDS = new Set([
    'start_date', 'end_date', 'scheduled_release_date', 'actual_release_date',
    'confirmed_at', 'setup_complete_date', 'created_at', 'updated_at', 'action_date'
  ]);
  const COLLECTIONS = new Set(['courses', 'work_logs', 'sub_books', 'sub_book_logs', 'users']);

  function normalizeError(error) {
    return error ? {
      message: error.message || String(error),
      code: error.code || error.name || 'firebase_error',
      details: error.stack || null
    } : null;
  }

  function isIsoDateString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
  }

  window.firebaseDbReady = (async function initializeFirebaseCompat() {
    const [appMod, authMod, fsMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js')
    ]);

    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    await authMod.signInAnonymously(auth);

    function toFirestoreValue(field, value) {
      if (value === null || value === undefined) return value;
      if (TIMESTAMP_FIELDS.has(field) && isIsoDateString(value)) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return fsMod.Timestamp.fromDate(date);
      }
      if (Array.isArray(value)) return value.map(v => toFirestoreValue(field, v));
      if (typeof value === 'object' && !(value instanceof Date)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = toFirestoreValue(k, v);
        return out;
      }
      return value;
    }

    function prepareWrite(input, idForInsert) {
      const source = { ...input };
      if (idForInsert && (source.id === undefined || source.id === null || source.id === '')) source.id = idForInsert;
      if (source.created_at === undefined) source.created_at = new Date().toISOString();
      const out = {};
      for (const [field, value] of Object.entries(source)) {
        if (value !== undefined) out[field] = toFirestoreValue(field, value);
      }
      return out;
    }

    function fromFirestoreValue(value) {
      if (value instanceof fsMod.Timestamp) return value.toDate().toISOString();
      if (Array.isArray(value)) return value.map(fromFirestoreValue);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = fromFirestoreValue(v);
        return out;
      }
      return value;
    }

    function mapDoc(snapshot) {
      const raw = fromFirestoreValue(snapshot.data());
      if (raw.id === undefined || raw.id === null || raw.id === '') raw.id = snapshot.id;
      return raw;
    }

    class FirebaseQueryBuilder {
      constructor(table, operation = 'select', payload = null, columns = '*', options = {}) {
        if (!COLLECTIONS.has(table)) throw new Error(`허용되지 않은 컬렉션: ${table}`);
        this.table = table;
        this.operation = operation;
        this.payload = payload;
        this.columns = columns;
        this.options = options || {};
        this.filters = [];
        this.orderSpec = null;
        this.limitCount = null;
        this.singleRow = false;
      }
      select(columns = '*', options = {}) { this.operation = 'select'; this.columns = columns; this.options = options || {}; return this; }
      insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
      update(payload) { this.operation = 'update'; this.payload = payload; return this; }
      delete() { this.operation = 'delete'; return this; }
      eq(field, value) { this.filters.push({ field, op: '==', value }); return this; }
      gte(field, value) { this.filters.push({ field, op: '>=', value }); return this; }
      in(field, values) { this.filters.push({ field, op: 'in', value: Array.isArray(values) ? values : [] }); return this; }
      order(field, options = {}) { this.orderSpec = { field, direction: options.ascending === false ? 'desc' : 'asc' }; return this; }
      limit(count) { this.limitCount = Number(count); return this; }
      single() { this.singleRow = true; return this; }
      then(resolve, reject) { return this.execute().then(resolve, reject); }

      _convertFilterValue(field, value) { return toFirestoreValue(field, value); }

      _queryRef() {
        const ref = fsMod.collection(db, this.table);
        const constraints = [];
        for (const f of this.filters) {
          if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 30) continue;
          const filterValue = f.op === 'in'
            ? f.value.map(v => this._convertFilterValue(f.field, v))
            : this._convertFilterValue(f.field, f.value);
          constraints.push(fsMod.where(f.field, f.op, filterValue));
        }
        if (this.orderSpec) constraints.push(fsMod.orderBy(this.orderSpec.field, this.orderSpec.direction));
        if (Number.isFinite(this.limitCount) && this.limitCount > 0) constraints.push(fsMod.limit(this.limitCount));
        return constraints.length ? fsMod.query(ref, ...constraints) : ref;
      }

      async _getSnapshotDocs() {
        const largeIn = this.filters.find(f => f.op === 'in' && Array.isArray(f.value) && f.value.length > 30);
        if (!largeIn) return (await fsMod.getDocs(this._queryRef())).docs;
        const snap = await fsMod.getDocs(fsMod.collection(db, this.table));
        let docs = snap.docs.filter(d => largeIn.value.includes(fromFirestoreValue(d.data()[largeIn.field])));
        if (this.orderSpec) {
          const dir = this.orderSpec.direction === 'desc' ? -1 : 1;
          const field = this.orderSpec.field;
          docs.sort((a, b) => {
            const av = fromFirestoreValue(a.data()[field]);
            const bv = fromFirestoreValue(b.data()[field]);
            return av < bv ? -dir : av > bv ? dir : 0;
          });
        }
        if (Number.isFinite(this.limitCount) && this.limitCount > 0) docs = docs.slice(0, this.limitCount);
        return docs;
      }

      _project(row) {
        if (!this.columns || this.columns === '*' || this.columns === 'count') return row;
        const names = String(this.columns).split(',').map(s => s.trim()).filter(Boolean);
        const projected = {};
        for (const name of names) projected[name] = row[name];
        return projected;
      }

      async _select() {
        const docs = await this._getSnapshotDocs();
        const count = docs.length;
        if (this.options && this.options.head) return { data: null, error: null, count };
        const rows = docs.map(mapDoc).map(row => this._project(row));
        if (this.singleRow) {
          if (rows.length !== 1) return { data: null, error: { message: `single() expected 1 row, received ${rows.length}`, code: 'PGRST116' }, count };
          return { data: rows[0], error: null, count };
        }
        return { data: rows, error: null, count };
      }

      async _insert() {
        const inputs = Array.isArray(this.payload) ? this.payload : [this.payload];
        const written = [];
        for (let i = 0; i < inputs.length; i += 450) {
          const batch = fsMod.writeBatch(db);
          for (const input of inputs.slice(i, i + 450)) {
            if (!input || typeof input !== 'object') continue;
            const explicitId = input.id !== undefined && input.id !== null && input.id !== '' ? String(input.id) : null;
            const ref = explicitId ? fsMod.doc(db, this.table, explicitId) : fsMod.doc(fsMod.collection(db, this.table));
            const data = prepareWrite(input, ref.id);
            batch.set(ref, data);
            written.push(fromFirestoreValue(data));
          }
          await batch.commit();
        }
        return { data: written, error: null, count: written.length };
      }

      async _matchingDocs() { return await this._getSnapshotDocs(); }

      async _update() {
        const docs = await this._matchingDocs();
        if (!docs.length) return { data: [], error: null, count: 0 };
        const prepared = prepareWrite(this.payload || {}, null);
        if (this.payload && this.payload.created_at === undefined) delete prepared.created_at;
        let processed = 0;
        for (let i = 0; i < docs.length; i += 450) {
          const batch = fsMod.writeBatch(db);
          for (const d of docs.slice(i, i + 450)) { batch.update(d.ref, prepared); processed++; }
          await batch.commit();
        }
        return { data: null, error: null, count: processed };
      }

      async _delete() {
        const docs = await this._matchingDocs();
        let processed = 0;
        for (let i = 0; i < docs.length; i += 450) {
          const batch = fsMod.writeBatch(db);
          for (const d of docs.slice(i, i + 450)) { batch.delete(d.ref); processed++; }
          await batch.commit();
        }
        return { data: null, error: null, count: processed };
      }

      async execute() {
        try {
          if (this.operation === 'select') return await this._select();
          if (this.operation === 'insert') return await this._insert();
          if (this.operation === 'update') return await this._update();
          if (this.operation === 'delete') return await this._delete();
          throw new Error(`지원하지 않는 작업: ${this.operation}`);
        } catch (error) {
          console.error(`[FirebaseCompat:${this.table}:${this.operation}]`, error);
          return { data: null, error: normalizeError(error), count: null };
        }
      }
    }

    class FirebaseRealtimeChannel {
      constructor(name) { this.name = name; this.listeners = []; this.unsubscribers = []; }
      on(eventName, config, callback) {
        if (eventName === 'postgres_changes' && config && COLLECTIONS.has(config.table) && typeof callback === 'function') {
          this.listeners.push({ table: config.table, callback });
        }
        return this;
      }
      subscribe() {
        for (const listener of this.listeners) {
          let initial = true;
          const unsubscribe = fsMod.onSnapshot(
            fsMod.collection(db, listener.table),
            () => {
              if (initial) { initial = false; return; }
              try { listener.callback(); } catch (error) { console.error(`[FirebaseRealtime:${listener.table}]`, error); }
            },
            error => console.error(`[FirebaseRealtime:${listener.table}]`, error)
          );
          this.unsubscribers.push(unsubscribe);
        }
        return this;
      }
      unsubscribe() { for (const fn of this.unsubscribers.splice(0)) { try { fn(); } catch (_) {} } }
    }

    const client = {
      from(table) { return new FirebaseQueryBuilder(table); },
      channel(name) { return new FirebaseRealtimeChannel(name); },
      firebase: { app, auth, db, config: firebaseConfig }
    };

    window.firebaseCompatClient = client;
    return client;
  })();
})();
