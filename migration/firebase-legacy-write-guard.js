// Safety guard for the Firebase migration preview.
// Read paths and realtime subscriptions remain available.
// Legacy sb.from(...).insert/update/delete calls are blocked by default.
// Converted atomic write services use Firestore directly and are not affected.
(function () {
  'use strict';

  window.firebaseLegacyGuardReady = (async function () {
    const client = await window.firebaseDbReady;
    if (!client || typeof client.from !== 'function') {
      throw new Error('Firebase compatibility client is not ready.');
    }
    if (client.__mgLegacyWriteGuardInstalled) return client;

    const originalFrom = client.from.bind(client);

    client.from = function guardedFrom(table) {
      const builder = originalFrom(table);
      if (!builder || typeof builder.execute !== 'function') return builder;

      const originalExecute = builder.execute.bind(builder);
      const writeMethods = ['insert', 'update', 'delete'];

      for (const method of writeMethods) {
        if (typeof builder[method] !== 'function') continue;
        const originalMethod = builder[method].bind(builder);
        builder[method] = function guardedWriteMethod(...args) {
          const result = originalMethod(...args);
          builder.__mgLegacyWriteOperation = method;
          return result;
        };
      }

      builder.execute = async function guardedExecute() {
        if (builder.__mgLegacyWriteOperation && window.MG_FIREBASE_ALLOW_LEGACY_WRITES !== true) {
          const op = builder.__mgLegacyWriteOperation;
          const error = {
            message: `Firebase 전환 안전장치: 아직 원자화되지 않은 레거시 ${op} 쓰기는 차단되었습니다.`,
            code: 'mg/legacy-write-blocked',
            details: `table=${table}, operation=${op}`
          };
          console.warn('[Firebase Migration] blocked legacy write', error);
          return { data: null, error, count: null };
        }
        return originalExecute();
      };

      return builder;
    };

    client.__mgLegacyWriteGuardInstalled = true;
    window.__mgLegacyWriteGuardReady = true;
    console.info('[Firebase Migration] legacy insert/update/delete guard enabled');
    return client;
  })();
})();
