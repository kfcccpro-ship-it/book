// Simple mobile inventory service.
// Core: safe stock-in/out, reversible hiding, display-name management, simple item creation.
(function () {
  'use strict';

  window.simpleInventoryServiceReady = (async function () {
    const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
    const client = await window.firebaseDbReady;
    const db = client.firebase.db;

    const timestampFields = new Set([
      'actual_release_date','updated_at','action