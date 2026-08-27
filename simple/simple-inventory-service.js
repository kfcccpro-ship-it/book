// Loader for the verified inventory service plus current UI terminology policy.
(function () {
  'use strict';

  let resolveReady;
  let rejectReady;
  const publicReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  window.simpleInventoryServiceReady = publicReady;

  function installUiTerminologyPolicy() {
    const replacements = [
      ['비상출고/재고맞춤', '즉시출고'],
      ['비상출고', '즉시출고'],
      ['실물재고 맞춤', '실물 수량 확인'],
      ['재고맞춤', '재고확인'],
      ['재고조정', '재고변경 · 과거 기록']
    ];

    function patchText(root) {
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|TEXTAREA|OPTION)$/i.test(parent.tagName)) continue;
        let next = node.nodeValue || '';
        for (const [from, to] of replacements) next = next.split(from).join(to);
        if (next !== node.nodeValue) node.nodeValue = next;
      }
    }

    function patchCurrentUi() {
      patchText(document.body);
      document.documentElement.dataset.inventoryUiPolicy = 'immediate-out-only';
    }

    const start = () => {
      patchCurrentUi();
      new MutationObserver(patchCurrentUi).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  function loadScript(src, marker) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-${marker}]`);
      if (existing) {
        if (existing.dataset.loaded === '1') { resolve(); return; }
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(`${src} 로드 실패`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.setAttribute(`data-${marker}`, '1');
      script.onload = () => { script.dataset.loaded = '1'; resolve(); };
      script.onerror = () => reject(new Error(`${src} 로드 실패`));
      document.head.appendChild(script);
    });
  }

  async function waitForSimpleWorkflow() {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      if (window.courseWorkflowSimpleV3?.installed === true) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('단순 교재 연결 화면을 초기화하지 못했습니다.');
  }

  const core = document.createElement('script');
  core.src = './simple-inventory-service-core.js?v=7';
  core.async = false;
  core.onload = async () => {
    const coreReady = window.simpleInventoryServiceReady;
    try {
      const service = await coreReady;
      window.simpleInventoryServiceReady = publicReady;
      installUiTerminologyPolicy();
      // Simplified rule: one textbook inventory group, multiple scheduled course runs.
      // Existing runs are preserved; new runs are appended with the same inventory_group_key.
      await loadScript('./course-workflow-simple-v3.js?v=4', 'course-workflow-simple-v3');
      await waitForSimpleWorkflow();
      await loadScript('./course-run-add.js?v=1', 'course-run-add');
      resolveReady(service);
    } catch (error) {
      rejectReady(error);
    }
  };
  core.onerror = () => rejectReady(new Error('교재 재고관리 핵심 서비스를 불러오지 못했습니다.'));
  document.head.appendChild(core);
})();
