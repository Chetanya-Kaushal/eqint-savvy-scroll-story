// Oracle's /workers REST resource returns almost nothing useful by default — name,
// department, and job data live in nested child resources (names, workRelationships,
// workRelationships.assignments) that must be explicitly requested via `expand`, or
// they are simply absent from the response. This constant is the expand list every
// Workers fetch in this app must include.
const WORKERS_EXPAND = 'expand=names,emails,phones,workRelationships.assignments';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// Flattens an expanded Workers item's nested names/workRelationships/assignments into
// flat top-level fields the rest of the app's display code already understands
// (DisplayName, DepartmentName, etc.), so formatters don't need to know about Oracle's
// nested response shape. Picks the current name (no end date, or the furthest-future
// end date) and the primary work relationship/assignment — falling back to the first
// entry of each array if no primary flag is set. Leaves non-Workers items untouched.
function flattenWorkerItem(item) {
  if (!item || !Array.isArray(item.names)) return item;

  const name = item.names.find((n) => !n.EffectiveEndDate || n.EffectiveEndDate === '4712-12-31') || item.names[0] || {};
  const workRelationships = item.workRelationships || [];
  const workRelationship = workRelationships.find((wr) => wr.PrimaryFlag) || workRelationships[0] || {};
  const assignments = workRelationship.assignments || [];
  const assignment = assignments.find((a) => a.PrimaryAssignmentFlag) || assignments[0] || {};
  const email = (item.emails || [])[0] || {};
  const phone = (item.phones || [])[0] || {};

  return {
    ...item,
    DisplayName: name.DisplayName,
    FirstName: name.FirstName,
    LastName: name.LastName,
    EmailAddress: email.EmailAddress,
    PhoneNumber: phone.PhoneNumber,
    DepartmentName: assignment.DepartmentName,
    BusinessUnitName: assignment.BusinessUnitName,
    JobTitle: assignment.AssignmentName,
    EmploymentStatus: assignment.AssignmentStatusType,
    EmploymentType: assignment.FullPartTime,
    StartDate: workRelationship.StartDate,
  };
}

module.exports = { WORKERS_EXPAND, todayDate, flattenWorkerItem };
