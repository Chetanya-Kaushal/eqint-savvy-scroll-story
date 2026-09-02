// Endpoints whose Oracle view object actually carries a PersonNumber/person-identifying
// attribute — safe to filter with `&q=PersonNumber='...'`. Everything else in HCM_ENDPOINTS
// is a reference/lookup table (Organizations, Locations, Jobs, Grades, *LOV endpoints, etc.)
// that has no such attribute — Oracle silently ignores an unrecognized filter attribute on
// many of these lookup view objects and returns the FULL unfiltered table instead of erroring,
// so these must never receive a person filter.
//
// This list (and each entry's personFilterField in HCM_ENDPOINTS) was verified live
// against a real Oracle tenant, not assumed from generic docs. A number of paths that
// look person-scoped by name were deliberately left OUT after live-testing PersonNumber,
// personNumber, and PersonId and getting a 400 "not valid" on all three: /personNotes,
// /timeAttributes, /webClockEvents, /scheduleRequests, /goalsProgressDetails,
// /talentFeedbackSuggestions, /learnerLearningRecords, /workerJourneyTasks,
// /recruitingMyJobApplications, /tasks, /businessProcessNotifications,
// /businessProcessTransactionManagementAsWorkers, /statusChangeRequests,
// /emailAddrMigrations, /documentDeliveryPreferences (500 error), and
// /recruitingCEInterviewScheduleDetails (401 — a different auth requirement entirely,
// per Oracle's docs /tasks is actually the separate BPM Tasks API, filtered by an
// `assignment` parameter like MY/REPORTEES rather than a person `q` filter at all).
// These still work fine as general (unfiltered) fetches when no person is resolved.
const PERSON_SCOPED_PATHS = new Set([
  '/workers', '/emps', '/publicWorkers', '/hcmContacts', '/areasOfResponsibility',
  '/absences', '/absenceNoEntitlements',
  '/payrollRelationships', '/elementEntries', '/calculationEntries', '/payAdvances', '/planBalances', '/payslips',
  '/benefitEnrollments', '/benefitEnrollmentOpportunities',
  '/salaries', '/compensationPeerSalaryPercentiles', '/compensationStockProfiles',
  '/timeRecords', '/timeRecordGroups', '/attendanceViolations',
  '/performanceGoals', '/goalPlanAssignees', '/performanceEvaluations',
  '/talentPersonProfiles', '/talentRatings',
  '/workerJourneys',
  '/recruitingJobApplications',
  '/documentRecords', '/communicateUIMyCommunications', '/checkInDocuments', '/allocatedChecklists',
  '/internetAccounts', '/userAccounts', '/careerInterests',
]);

function isPersonScoped(path) {
  return PERSON_SCOPED_PATHS.has(path);
}

function scopeEndpointsToPerson(endpoints) {
  const personScoped = endpoints.filter((ep) => isPersonScoped(ep.path));
  const referenceOnly = endpoints.filter((ep) => !isPersonScoped(ep.path));
  return { personScoped, referenceOnly };
}

module.exports = { isPersonScoped, scopeEndpointsToPerson, PERSON_SCOPED_PATHS };
