/**
 * PTO Request → Create Time Entries (Workflow Action) — safe-load v1.1
 * - Weekdays only
 * - Skips subsidiary holidays (customrecord_hol_schedule)
 * - Books to subsidiary's PTO Project/Task (custrecord_pto_project / custrecord_pto_task)
 * - Uses your time task field: casetaskevent
 *
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 */
define(['N/record','N/search','N/format','N/log'], function(record, search, format, log) {

  // ====== PTO Request fields ======
  var PTO_REQ = {
    TYPE:  'customrecord_time_off_request',
    EMP:   'custrecord_tor_emp',
    START: 'custrecord_tor_start',
    END:   'custrecord_tor_end',
    HRS:   'custrecord_tor_hours',
    MEMO:  'custrecord_tor_memo'
  };

  // ====== Subsidiary fields (PTO routing) ======
  var SUB_FLD = {
    PTO_PROJECT: 'custrecord_pto_project', // Job/Customer
    PTO_TASK:    'custrecord_pto_task'     // Project Task (time field id is 'casetaskevent')
  };

  // ====== Holiday record (for skipping) ======
  var HOLIDAY = {
    TYPE:       'customrecord_hol_schedule',
    DATE:       'custrecord_hol_date',
    SUBSIDIARY: 'custrecord_hol_subsidiary'
  };

  // ====== Time Entry fields/ids (raw type id to avoid load-time API reads) ======
  var TIME = {
    TYPE:      'timebill',     // (instead of record.Type.TIME_BILL)
    EMPLOYEE:  'employee',
    DATE:      'date',
    TRANDATE:  'trandate',
    HOURS:     'hours',
    APPROVED:  'approved',
    CUSTOMER:  'customer',     // Job/Customer
    TASK:      'casetaskevent',// your account's task field id
    MEMO:      'memo'
  };

  // ====== Config ======
  var SET_APPROVED = true;     // mark time entries approved (since PTO is approved)
  var DEDUPE_ON = { date: true, customer: true, task: true };

  // ====== helpers (NO API calls at top level) ======
  function isWeekend(d) { var day = d.getDay(); return day === 0 || day === 6; }
  function asNsDate(d) { return format.format({ value: d, type: format.Type.DATE }); }
  function toJsDate(v) { return (v instanceof Date) ? v : format.parse({ value: v, type: format.Type.DATE }); }
  function* daysInclusive(start, end) {
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    var last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (d <= last) { yield new Date(d); d.setDate(d.getDate() + 1); }
  }

  function loadEmployeeSubsidiary(empId) {
    var emp = record.load({ type: record.Type.EMPLOYEE, id: empId });
    return emp.getValue('subsidiary') || null;
  }

  function loadSubsidiaryPtoRouting(subId) {
    if (!subId) return { projectId: null, taskId: null };
    var sub = record.load({ type: record.Type.SUBSIDIARY, id: subId });
    return {
      projectId: sub.getValue(SUB_FLD.PTO_PROJECT) || null,
      taskId:    sub.getValue(SUB_FLD.PTO_TASK)    || null
    };
  }

  function isHolidayForSubsidiary(subId, jsDate) {
    if (!subId || !jsDate) return false;
    var dStr = asNsDate(jsDate);
    var filters = [
      [HOLIDAY.SUBSIDIARY, 'anyof', subId], 'AND',
      [HOLIDAY.DATE, 'on', dStr]
    ];
    try {
      var rs = search.create({ type: HOLIDAY.TYPE, filters: filters, columns: ['internalid'] })
                     .run().getRange({ start: 0, end: 1 });
      return !!(rs && rs.length);
    } catch (e) {
      // fallback: same-day inclusive range if 'on' is picky
      var rs2 = search.create({
        type: HOLIDAY.TYPE,
        filters: [
          [HOLIDAY.SUBSIDIARY,'anyof',subId],'AND',
          [HOLIDAY.DATE,'onorafter', dStr],'AND',
          [HOLIDAY.DATE,'onorbefore', dStr]
        ],
        columns: ['internalid']
      }).run().getRange({ start: 0, end: 1 });
      return !!(rs2 && rs2.length);
    }
  }

  function timeExists(empId, jsDate, projectId, taskId) {
    var dStr = asNsDate(jsDate);
    var filters = [
      [TIME.EMPLOYEE, 'anyof', empId], 'AND',
      [TIME.DATE,     'on', dStr]
    ];
    if (DEDUPE_ON.customer && projectId) filters.push('AND', [TIME.CUSTOMER, 'anyof', projectId]);
    if (DEDUPE_ON.task     && taskId)    filters.push('AND', [TIME.TASK,     'anyof', taskId]);

    try {
      var rs = search.create({ type: TIME.TYPE, filters: filters, columns: ['internalid'] })
                     .run().getRange({ start: 0, end: 1 });
      return !!(rs && rs.length);
    } catch (e) {
      // fallback to same-day inclusive range
      var f2 = [
        [TIME.EMPLOYEE, 'anyof', empId], 'AND',
        [TIME.DATE, 'onorafter', dStr], 'AND',
        [TIME.DATE, 'onorbefore', dStr]
      ];
      if (DEDUPE_ON.customer && projectId) f2.push('AND', [TIME.CUSTOMER,'anyof',projectId]);
      if (DEDUPE_ON.task     && taskId)    f2.push('AND', [TIME.TASK,    'anyof',taskId]);
      var rs2 = search.create({ type: TIME.TYPE, filters: f2, columns: ['internalid'] })
                      .run().getRange({ start: 0, end: 1 });
      return !!(rs2 && rs2.length);
    }
  }

  function createTime(empId, jsDate, hours, projectId, taskId, memo) {
    var t = record.create({ type: TIME.TYPE, isDynamic: true });
    t.setValue({ fieldId: TIME.EMPLOYEE, value: empId });
    t.setValue({ fieldId: TIME.DATE,     value: jsDate }); // JS Date
    t.setValue({ fieldId: TIME.TRANDATE, value: jsDate }); // belt & suspenders
    t.setValue({ fieldId: TIME.HOURS,    value: Number(hours) || 0 });
    if (projectId) t.setValue({ fieldId: TIME.CUSTOMER, value: projectId });
    if (taskId)    t.setValue({ fieldId: TIME.TASK,     value: taskId });
    if (memo)      t.setValue({ fieldId: TIME.MEMO,     value: memo });
    if (SET_APPROVED) t.setValue({ fieldId: TIME.APPROVED, value: true });
    return t.save();
  }

  function onAction(ctx) {
    var rec = ctx.newRecord; // PTO Request
    try {
      var empId   = rec.getValue(PTO_REQ.EMP);
      var startV  = rec.getValue(PTO_REQ.START);
      var endV    = rec.getValue(PTO_REQ.END);
      var hours   = Number(rec.getValue(PTO_REQ.HRS)) || 0;
      var memoRaw = rec.getValue(PTO_REQ.MEMO);

      if (!empId || !startV || !endV || !hours) {
        log.error('Missing required PTO request fields', { empId: empId, startV: startV, endV: endV, hours: hours });
        return;
      }

      var start = toJsDate(startV);
      var end   = toJsDate(endV);
      if (end < start) {
        log.error('End date before start date; skipping', { start: asNsDate(start), end: asNsDate(end) });
        return;
      }

      // Subsidiary → PTO project/task
      var subId = loadEmployeeSubsidiary(empId);
      var routing = loadSubsidiaryPtoRouting(subId);
      var projectId = routing.projectId;
      var taskId    = routing.taskId;

      var memo = memoRaw ? ('PTO – ' + memoRaw) : 'PTO';

      var created = [];
      for (var dIter = daysInclusive(start, end), step = dIter.next(); !step.done; step = dIter.next()) {
        var d = step.value;
        if (isWeekend(d)) continue;
        if (isHolidayForSubsidiary(subId, d)) {
          log.debug('Skipping holiday', { empId: empId, date: asNsDate(d), subId: subId });
          continue;
        }
        if (timeExists(empId, d, projectId, taskId)) {
          log.debug('Skipping existing time', { empId: empId, date: asNsDate(d), projectId: projectId, taskId: taskId });
          continue;
        }
        var id = createTime(empId, d, hours, projectId, taskId, memo);
        created.push({ id: id, date: asNsDate(d) });
      }

      log.audit('PTO time entries created', { count: created.length, created: created, empId: empId, projectId: projectId, taskId: taskId });

    } catch (e) {
      log.error('PTO WF Action failed', { message: e.message, stack: e.stack });
      // throw e; // uncomment if you want the workflow to show a hard error
    }
  }

  return { onAction: onAction };
});