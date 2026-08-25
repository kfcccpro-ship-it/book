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
    if (document.querySelector(`script[data-${marker}]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.setAttribute(`data-${marker}`, '1');
    document.head.appendChild(script);
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
      loadScript('./course-workflow-v2.js?v=2', 'course-workflow-v2');
      loadScript('./inventory-link-fix-v3.js?v=2', 'inventory-link-fix-v3');
      resolveReady(service);
    } catch (error) {
      rejectReady(error);
    }
  };
  core.onerror = () => rejectReady(new Error('교재 재고관리 핵심 서비스를 불러오지 못했습니다.'));
  document.head.appendChild(core);
})();
