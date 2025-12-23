/**
 * PTO Request → Create Time Entries (Workflow Action) — v2.0
 * - Creates time entries for PTO Requests
 * - Uses NEW logic: PTO Request Type determines task (1222/1223)
 * - Project ALWAYS = 2156 ("Leave Project")
 * - Skips weekends & subsidiary holidays
 * - Dedupes time on same day/project/task
 *
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 */
define(['N/record','N/search','N/format','N/log'], function(record, search, format, log) {

  // ===== PTO Request fields =====
  var PTO_REQ = {
    TYPE:  'customrecord_time_off_request',
    EMP:   'custrecord_tor_emp',
    START: 'custrecord_tor_start',
    END:   'custrecord_tor_end',
    HRS:   'custrecord_tor_hours',
    MEMO:  'custrecord_tor_memo',
    PTO_TYPE: 'custrecord_tor_type'   // *** NEW FIELD ***
  };

  // ===== Holiday record =====
  var HOLIDAY = {
    TYPE:       'customrecord_hol_schedule',
    DATE:       'custrecord_hol_date',
    SUBSIDIARY: 'custrecord_hol_subsidiary'
  };

  // ===== Time Entry fields =====
  var TIME = {
    TYPE:      'timebill',
    EMPLOYEE:  'employee',
    DATE:      'date',
    TRANDATE:  'trandate',
    HOURS:     'hours',
    APPROVED:  'approved',
    CUSTOMER:  'customer',       // Project/Job
    TASK:      'casetaskevent',  // Project Task
    MEMO:      'memo'
  };

  // ===== Config =====
  var SET_APPROVED = true;
  var PROJECT_LEAVE = 2156;           // *** New: Always use this project ***
  var TASK_PTO = 1222;                // *** PTO task ***
  var TASK_FLOATING = 1223;           // *** Floating Holiday task ***

  var DEDUPE_ON = { date: true, customer: true, task: true };

  // ===== helpers =====
  function isWeekend(d) { var day = d.getDay(); return day === 0 || day === 6; }
  function asNsDate(d) { return format.format({ value: d, type: format.Type.DATE }); }
  function toJsDate(v) { return (v instanceof Date) ? v : format.parse({ value: v, type: format.Type.DATE }); }
  function* daysInclusive(start, end) { var d = new Date(start); while (d <= end) { yield new Date(d); d.setDate(d.getDate()+1);} }

  function isHolidayForSubsidiary(subId, jsDate) {
    if (!subId || !jsDate) return false;
    var dStr = asNsDate(jsDate);
    var rs = search.create({
      type: HOLIDAY.TYPE,
      filters: [
        [HOLIDAY.SUBSIDIARY, 'anyof', subId], 'AND',
        [HOLIDAY.DATE, 'on', dStr]
      ],
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1 });
    return !!(rs && rs.length);
  }

  function timeExists(empId, jsDate, projectId, taskId) {
    var dStr = asNsDate(jsDate);
    var filters = [
      [TIME.EMPLOYEE, 'anyof', empId], 'AND',
      [TIME.DATE,     'on', dStr],     'AND',
      [TIME.CUSTOMER, 'anyof', projectId], 'AND',
      [TIME.TASK,     'anyof', taskId]
    ];
    var rs = search.create({
      type: TIME.TYPE,
      filters: filters,
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1 });
    return !!(rs && rs.length);
  }

  function createTime(empId, jsDate, hours, projectId, taskId, memo) {
    var t = record.create({ type: TIME.TYPE, isDynamic: true });
    t.setValue({ fieldId: TIME.EMPLOYEE, value: empId });
    t.setValue({ fieldId: TIME.DATE,     value: jsDate });
    t.setValue({ fieldId: TIME.TRANDATE, value: jsDate });
    t.setValue({ fieldId: TIME.HOURS,    value: Number(hours) || 0 });
    t.setValue({ fieldId: TIME.CUSTOMER, value: projectId });
    t.setValue({ fieldId: TIME.TASK,     value: taskId });
    if (memo) t.setValue({ fieldId: TIME.MEMO, value: memo });
    if (SET_APPROVED) t.setValue({ fieldId: TIME.APPROVED, value: true });
    return t.save();
  }

  function onAction(ctx) {
    var rec = ctx.newRecord;  // PTO Request
    try {
      var empId  = rec.getValue(PTO_REQ.EMP);
      var startV = rec.getValue(PTO_REQ.START);
      var endV   = rec.getValue(PTO_REQ.END);
      var hours  = Number(rec.getValue(PTO_REQ.HRS)) || 0;
      var memoRaw = rec.getValue(PTO_REQ.MEMO);
      var ptoType = String(rec.getValue(PTO_REQ.PTO_TYPE)); // *** NEW ***

      if (!empId || !startV || !endV || !hours || !ptoType) {
        log.error('Missing required PTO fields', { empId, startV, endV, hours, ptoType });
        return;
      }

      // Determine task based on type
      var taskId = null;
      if (ptoType === "2") taskId = TASK_PTO;
      else if (ptoType === "3") taskId = TASK_FLOATING;

      if (!taskId) {
        log.error("Invalid PTO type selected on request", { ptoType });
        return;
      }

      var projectId = PROJECT_LEAVE; // always this project

      // Fix memo
      var memo = memoRaw ? (memoRaw) : "PTO";

      var start = toJsDate(startV);
      var end   = toJsDate(endV);

      var empSub = record.load({ type: record.Type.EMPLOYEE, id: empId }).getValue('subsidiary');

      var created = [];
      for (var dIter = daysInclusive(start, end), step = dIter.next(); !step.done; step = dIter.next()) {
        var d = step.value;
        if (isWeekend(d)) continue;
        if (isHolidayForSubsidiary(empSub, d)) continue;
        if (timeExists(empId, d, projectId, taskId)) continue;

        var id = createTime(empId, d, hours, projectId, taskId, memo);
        created.push({ id: id, date: asNsDate(d) });
      }

      log.audit('PTO Time Entries Created', {
        count: created.length,
        entries: created,
        empId,
        projectId,
        taskId
      });

    } catch (e) {
      log.error('PTO WF Action Failed', { message: e.message, stack: e.stack });
    }
  }

  return { onAction: onAction };
});
