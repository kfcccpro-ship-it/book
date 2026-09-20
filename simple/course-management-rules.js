// Pure validation/linking rules shared by the Simple course-management screens.
// Kept free of Firebase and DOM dependencies so data-safety rules can be regression-tested.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.courseManagementRules = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
  const normalizeName = value => clean(value).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
  const normalizeRunLabel = value => normalizeName(value).replace(/^제(?=\d+차)/, '');

  function inferRunLabel(course, groupName) {
    const stored = clean(course?.course_run_label);
    if (stored) return stored;
    const name = clean(course?.course_name);
    const base = clean(groupName);
    if (base && name.startsWith(base) && name.length > base.length) return clean(name.slice(base.length));
    const match = name.match(/((?:제\s*)?\d+\s*차(?:\s*\([^)]*\))?.*)$/);
    return match ? clean(match[1]) : '';
  }

  function representativeNameConflict(groups, currentGroupKey, candidateName) {
    const candidate = normalizeName(candidateName);
    if (!candidate) return null;
    return (groups || []).find(group =>
      String(group?.key || '') !== String(currentGroupKey || '') &&
      normalizeName(group?.name) === candidate
    ) || null;
  }

  function runLabelConflict(courses, currentCourseId, candidateLabel, groupName) {
    const candidate = normalizeRunLabel(candidateLabel);
    if (!candidate) return null;
    return (courses || []).find(course => {
      if (String(course?.id || '') === String(currentCourseId || '')) return false;
      if (course?.inventory_ledger_only === true) return false;
      const label = inferRunLabel(course, groupName) || clean(course?.course_name);
      return normalizeRunLabel(label) === candidate;
    }) || null;
  }

  function linkedSubBooksForRename(subBooks, groupKey, previousGroupName) {
    const key = String(groupKey || '');
    const oldName = normalizeName(previousGroupName);
    return (subBooks || []).filter(book => {
      const bookKey = String(book?.course_group_key || '');
      const legacyName = normalizeName(book?.course_group_name || book?.course_group_key || '');
      return bookKey === key || (!!oldName && legacyName === oldName);
    });
  }

  return Object.freeze({
    clean,
    normalizeName,
    normalizeRunLabel,
    inferRunLabel,
    representativeNameConflict,
    runLabelConflict,
    linkedSubBooksForRename
  });
});
